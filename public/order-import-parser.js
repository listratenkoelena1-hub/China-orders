(function (root, factory) {
    const api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.ChinaOrdersImportParser = api;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const ACTUAL_PRICE_PATTERN = /оплат|наличн|фактич|实付|付款|成交|paid|payment/i;
    const SUMMARY_PATTERN = /общая\s+первонач|фрахт|комисси|运费|物流|合计|total|freight|shipping|processing\s+fee/i;
    const FREIGHT_PATTERN = /фрахт|运费|物流费|freight|shipping/i;
    const FEE_PATTERN = /комисси|обработк|иностранн|手续费|服务费|foreign\s+currency|processing\s+fee/i;
    const EXCLUDED_LINE_PATTERN = /получено|добави|повтор|отслед|received|add\s+to|reorder/i;

    function numberFromText(value) {
        const normalized = String(value || '')
            .replace(/\s/g, '')
            .replace(',', '.')
            .replace(/[^0-9.\-]/g, '');
        const parsed = Number.parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function roundMoney(value) {
        return Math.round((Number(value) || 0) * 100) / 100;
    }

    function parseTsvWords(tsv) {
        return String(tsv || '')
            .split(/\r?\n/)
            .slice(1)
            .map(row => {
                const columns = row.split('\t');
                if (columns.length < 12 || Number(columns[0]) !== 5) return null;

                const text = columns.slice(11).join('\t').trim();
                if (!text) return null;

                return {
                    page: Number(columns[1]) || 0,
                    block: Number(columns[2]) || 0,
                    paragraph: Number(columns[3]) || 0,
                    line: Number(columns[4]) || 0,
                    word: Number(columns[5]) || 0,
                    x: Number(columns[6]) || 0,
                    y: Number(columns[7]) || 0,
                    width: Number(columns[8]) || 0,
                    height: Number(columns[9]) || 0,
                    confidence: Number(columns[10]) || 0,
                    text
                };
            })
            .filter(Boolean);
    }

    function buildLines(words) {
        const groups = new Map();

        words.forEach(word => {
            const key = `${word.page}:${word.block}:${word.paragraph}:${word.line}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(word);
        });

        return [...groups.values()]
            .map(group => {
                const ordered = [...group].sort((a, b) => a.x - b.x);
                const left = Math.min(...ordered.map(word => word.x));
                const top = Math.min(...ordered.map(word => word.y));
                const right = Math.max(...ordered.map(word => word.x + word.width));
                const bottom = Math.max(...ordered.map(word => word.y + word.height));

                return {
                    words: ordered,
                    text: ordered.map(word => word.text).join(' '),
                    left,
                    top,
                    right,
                    bottom,
                    centerY: (top + bottom) / 2
                };
            })
            .sort((a, b) => a.top - b.top || a.left - b.left);
    }

    function decimalMatchesForWord(word) {
        const matches = [];
        const pattern = /-?\d+[.,]\d{1,3}/g;
        let match;

        while ((match = pattern.exec(word.text)) !== null) {
            const value = numberFromText(match[0]);
            if (value === null) continue;

            const relative = word.text.length > 1 ? match.index / word.text.length : 0;
            matches.push({
                value,
                raw: match[0],
                x: word.x + word.width * relative,
                y: word.y,
                width: word.width,
                height: word.height,
                confidence: word.confidence
            });
        }

        return matches;
    }

    function decimalMatchesForLine(line) {
        return line.words.flatMap(decimalMatchesForWord);
    }

    function quantityFromWord(word) {
        const compact = word.text.replace(/\s/g, '');
        const match = compact.match(/^[xхХ×][xхХ×]?([0-9iIl|]{1,4})$/i);
        if (!match) return null;

        const normalizedQuantity = match[1].replace(/[iIl|]/g, '1');
        const quantity = Number.parseInt(normalizedQuantity, 10);
        return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
    }

    function findQuantityAnchors(words, imageWidth) {
        const anchors = words
            .map(word => ({ word, quantity: quantityFromWord(word) }))
            .filter(item => item.quantity && item.word.x >= imageWidth * 0.7)
            .map(item => ({
                quantity: item.quantity,
                x: item.word.x,
                y: item.word.y,
                centerY: item.word.y + item.word.height / 2,
                confidence: item.word.confidence
            }))
            .sort((a, b) => a.centerY - b.centerY);

        return anchors.filter((anchor, index) => (
            index === 0 || Math.abs(anchor.centerY - anchors[index - 1].centerY) > 18
        ));
    }

    function priceForAnchor(anchor, lines, imageWidth) {
        const minY = anchor.centerY - imageWidth * 0.25;
        const maxY = anchor.centerY - Math.max(4, imageWidth * 0.008);
        const candidates = [];

        lines.forEach(line => {
            if (line.centerY < minY || line.centerY > maxY) return;
            if (SUMMARY_PATTERN.test(line.text)) return;

            decimalMatchesForLine(line)
                .filter(amount => amount.x >= imageWidth * 0.68 && amount.value >= 0)
                .forEach(amount => {
                    candidates.push({
                        line,
                        amount,
                        isActual: ACTUAL_PRICE_PATTERN.test(line.text)
                    });
                });
        });

        candidates.sort((a, b) => {
            if (a.isActual !== b.isActual) return a.isActual ? -1 : 1;
            return a.amount.y - b.amount.y || b.amount.x - a.amount.x;
        });

        return candidates[0] || null;
    }

    function rightPriceLines(lines, imageWidth) {
        return lines
            .map(line => {
                const amounts = decimalMatchesForLine(line)
                    .filter(amount => amount.x >= imageWidth * 0.76 && amount.value >= 0)
                    .sort((a, b) => b.x - a.x);

                return amounts.length > 0 ? { line, amount: amounts[0] } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.amount.y - b.amount.y || b.amount.x - a.amount.x);
    }

    function amountsCanBePricePair(first, second) {
        const largest = Math.max(first.amount.value, second.amount.value);
        if (largest === 0) return true;
        return Math.min(first.amount.value, second.amount.value) / largest >= 0.42;
    }

    function findPricePairs(lines, imageWidth) {
        const priceLines = rightPriceLines(lines, imageWidth);
        const pairs = [];

        for (let index = 0; index < priceLines.length - 1; index++) {
            const first = priceLines[index];
            const second = priceLines[index + 1];
            const gap = second.amount.y - first.amount.y;

            if (gap < imageWidth * 0.025 || gap > imageWidth * 0.065) continue;
            if (!amountsCanBePricePair(first, second)) continue;

            pairs.push({
                price: {
                    line: first.line,
                    amount: first.amount,
                    isActual: true
                },
                originalPrice: second
            });
            index++;
        }

        return pairs;
    }

    function findItemDetections(words, lines, imageWidth) {
        const quantityAnchors = findQuantityAnchors(words, imageWidth);
        const pricePairs = findPricePairs(lines, imageWidth);
        const usedAnchors = new Set();

        const detections = pricePairs.map(pair => {
            const expectedQuantityY = pair.price.amount.y + imageWidth * 0.12;
            const anchor = quantityAnchors
                .map((candidate, index) => ({ candidate, index }))
                .filter(item => !usedAnchors.has(item.index))
                .filter(item => {
                    const gap = item.candidate.centerY - pair.price.amount.y;
                    return gap >= imageWidth * 0.06 && gap <= imageWidth * 0.19;
                })
                .sort((a, b) => (
                    Math.abs(a.candidate.centerY - expectedQuantityY)
                    - Math.abs(b.candidate.centerY - expectedQuantityY)
                ))[0];

            if (anchor) usedAnchors.add(anchor.index);

            const inferredCenterY = pair.originalPrice.amount.y + imageWidth * 0.07;
            return {
                quantity: anchor ? anchor.candidate.quantity : 1,
                centerY: anchor ? anchor.candidate.centerY : inferredCenterY,
                confidence: anchor
                    ? Math.round((anchor.candidate.confidence + pair.price.amount.confidence) / 2)
                    : Math.round(pair.price.amount.confidence),
                price: pair.price,
                inferredQuantity: !anchor
            };
        });

        quantityAnchors.forEach((anchor, index) => {
            if (usedAnchors.has(index)) return;
            const price = priceForAnchor(anchor, lines, imageWidth);
            if (!price) return;

            const alreadyDetected = detections.some(detection => (
                Math.abs(detection.price.amount.y - price.amount.y) < imageWidth * 0.05
            ));
            if (alreadyDetected) return;

            detections.push({
                quantity: anchor.quantity,
                centerY: anchor.centerY,
                confidence: Math.round((anchor.confidence + price.amount.confidence) / 2),
                price,
                inferredQuantity: false
            });
        });

        return detections.sort((a, b) => a.price.amount.y - b.price.amount.y);
    }

    function cleanDescriptionLine(line, imageWidth) {
        if (EXCLUDED_LINE_PATTERN.test(line.text)) return '';

        const text = line.words
            .filter(word => word.x >= imageWidth * 0.28 && word.x <= imageWidth * 0.65)
            .filter(word => word.confidence >= 35)
            .map(word => word.text)
            .join(' ')
            .replace(/оплатить|наличными|фактически|实付款|付款/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!/[A-Za-zА-Яа-яЁё\u4e00-\u9fff]/.test(text)) return '';
        return text;
    }

    function descriptionForItem(index, detections, lines, imageWidth, summaryY) {
        const detection = detections[index];
        const price = detection?.price;
        if (!price) return '';

        const startY = price.amount.y - imageWidth * 0.02;
        const nextPriceY = detections[index + 1]?.price?.amount?.y;
        const localBoundary = Number.isFinite(nextPriceY)
            ? (price.amount.y + nextPriceY) / 2
            : price.amount.y + imageWidth * 0.28;
        const endY = Math.min(
            Number.isFinite(summaryY) ? summaryY : Number.POSITIVE_INFINITY,
            localBoundary
        );

        const pieces = lines
            .filter(line => line.centerY >= startY && line.centerY < endY)
            .map(line => cleanDescriptionLine(line, imageWidth))
            .filter(Boolean);

        return pieces.join(' ').replace(/\s+/g, ' ').trim().slice(0, 320);
    }

    function photoCropForPrice(price, imageWidth, imageHeight) {
        const size = Math.max(72, Math.min(Math.round(imageWidth * 0.255), imageWidth - 24));
        const left = Math.max(0, Math.round(imageWidth * 0.025));
        const top = Math.max(0, Math.min(
            Math.round(price.amount.y - imageWidth * 0.022),
            imageHeight - size
        ));

        return { left, top, width: size, height: size };
    }

    function firstMatchingLineIndex(lines, pattern, minimumY) {
        return lines.findIndex(line => line.centerY >= minimumY && pattern.test(line.text));
    }

    function joinedNearbyText(lines, startIndex, imageHeight) {
        if (startIndex < 0) return '';
        const first = lines[startIndex];
        const maxY = first.top + imageHeight * 0.075;

        return lines
            .slice(startIndex)
            .filter(line => line.top <= maxY)
            .map(line => line.text)
            .join(' ');
    }

    function decimalsFromText(text) {
        return [...String(text || '').matchAll(/-?\d+[.,]\d{1,3}/g)]
            .map(match => numberFromText(match[0]))
            .filter(value => value !== null);
    }

    function likelyYuanEquivalent(amounts) {
        if (amounts.length < 2) return null;

        const foreignAmount = amounts[0].value;
        const yuanAmount = amounts[amounts.length - 1];
        const candidates = [yuanAmount.value];
        const normalizedRaw = String(yuanAmount.raw || '').replace(',', '.');
        const parts = normalizedRaw.split('.');

        if (parts.length === 2 && parts[0].length > 1) {
            for (let cut = 1; cut < parts[0].length; cut++) {
                const candidate = numberFromText(`${parts[0].slice(cut)}.${parts[1]}`);
                if (candidate !== null) candidates.push(candidate);
            }
        }

        if (foreignAmount > 0) {
            const plausible = candidates
                .filter(value => value / foreignAmount >= 3 && value / foreignAmount <= 12)
                .sort((a, b) => Math.abs(a / foreignAmount - 7) - Math.abs(b / foreignAmount - 7));
            if (plausible.length > 0) return roundMoney(plausible[0]);
        }

        return roundMoney(yuanAmount.value);
    }

    function freightFromLines(lines, minimumY) {
        const index = firstMatchingLineIndex(lines, FREIGHT_PATTERN, minimumY);
        if (index < 0) return null;
        const amounts = decimalMatchesForLine(lines[index]);
        if (amounts.length === 0) return null;
        return roundMoney(amounts.sort((a, b) => b.x - a.x)[0].value);
    }

    function feeFromLines(lines, minimumY, imageHeight) {
        const index = firstMatchingLineIndex(lines, FEE_PATTERN, minimumY);
        if (index < 0) return null;

        const nearbyLines = lines
            .slice(index)
            .filter(line => line.top <= lines[index].top + imageHeight * 0.075);
        const multiAmountLine = nearbyLines
            .map(line => decimalMatchesForLine(line))
            .find(amounts => amounts.length >= 2);

        if (multiAmountLine) return likelyYuanEquivalent(multiAmountLine);

        const nearby = joinedNearbyText(lines, index, imageHeight);
        const yuanMatches = [...nearby.matchAll(/(-?\d+[.,]\d{1,3})\s*[¥￥]/g)]
            .map(match => numberFromText(match[1]))
            .filter(value => value !== null);

        if (yuanMatches.length > 0) return roundMoney(yuanMatches[yuanMatches.length - 1]);

        const amounts = decimalsFromText(nearby);
        if (amounts.length >= 2) return roundMoney(amounts[amounts.length - 1]);
        return null;
    }

    function summaryFromPosition(lines, minimumY, imageWidth) {
        const entries = lines
            .filter(line => line.centerY >= minimumY)
            .map(line => ({
                line,
                amounts: decimalMatchesForLine(line)
            }))
            .filter(entry => entry.amounts.some(amount => amount.x >= imageWidth * 0.68))
            .sort((a, b) => a.line.top - b.line.top);

        const feeIndex = entries.findIndex(entry => entry.amounts.length >= 2);
        if (feeIndex <= 0) {
            return { freight: null, processingFee: null, top: null };
        }

        const freightAmounts = entries[feeIndex - 1].amounts
            .filter(amount => amount.x >= imageWidth * 0.68)
            .sort((a, b) => b.x - a.x);

        return {
            freight: freightAmounts.length > 0 ? roundMoney(freightAmounts[0].value) : null,
            processingFee: likelyYuanEquivalent(entries[feeIndex].amounts),
            top: entries[Math.max(0, feeIndex - 2)]?.line?.top ?? entries[feeIndex - 1].line.top
        };
    }

    function parseOrderScreenshotTsv(tsv, imageWidth, imageHeight) {
        const words = parseTsvWords(tsv);
        const lines = buildLines(words);
        const detections = findItemDetections(words, lines, imageWidth);
        const lastDetectionY = detections.length > 0
            ? detections[detections.length - 1].centerY
            : imageHeight * 0.45;
        const positionalSummary = summaryFromPosition(
            lines,
            lastDetectionY + imageWidth * 0.12,
            imageWidth
        );
        const summaryLine = lines.find(line => line.centerY > lastDetectionY && SUMMARY_PATTERN.test(line.text));
        const summaryY = summaryLine?.top ?? positionalSummary.top ?? imageHeight;

        const items = detections
            .map((detection, index) => {
                const price = detection.price;

                return {
                    quantity: detection.quantity,
                    price: roundMoney(price.amount.value),
                    description: descriptionForItem(index, detections, lines, imageWidth, summaryY),
                    crop: photoCropForPrice(price, imageWidth, imageHeight),
                    confidence: detection.confidence,
                    inferredQuantity: detection.inferredQuantity
                };
            })
            .filter(Boolean);

        const freight = freightFromLines(lines, lastDetectionY) ?? positionalSummary.freight;
        const processingFee = feeFromLines(lines, lastDetectionY, imageHeight) ?? positionalSummary.processingFee;
        const warnings = [];

        if (items.length === 0) warnings.push('Товары не распознаны');
        if (freight === null) warnings.push('Фрахт не распознан');
        if (processingFee === null) warnings.push('Комиссия не распознана — при необходимости введите её вручную');

        return {
            items,
            freight,
            processingFee,
            warnings,
            rawText: lines.map(line => line.text).join('\n')
        };
    }

    function allocateMoney(total, weights) {
        const normalizedWeights = weights.map(value => Math.max(0, Number(value) || 0));
        const weightTotal = normalizedWeights.reduce((sum, value) => sum + value, 0);
        const results = new Array(normalizedWeights.length).fill(0);
        const totalCents = Math.max(0, Math.round((Number(total) || 0) * 100));

        if (totalCents === 0 || weightTotal === 0) return results;

        let used = 0;
        const calculated = normalizedWeights.map((weight, index) => {
            const raw = totalCents * weight / weightTotal;
            const cents = Math.floor(raw);
            used += cents;
            return { index, cents, remainder: raw - cents };
        });

        calculated.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

        for (let index = 0; index < totalCents - used; index++) {
            calculated[index % calculated.length].cents += 1;
        }

        calculated.forEach(item => {
            results[item.index] = item.cents / 100;
        });

        return results;
    }

    function normalizeOverlapDescription(value) {
        const latinToCyrillic = {
            a: 'а', b: 'в', c: 'с', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'н',
            i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'р',
            q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'ш', x: 'х',
            y: 'у', z: 'з'
        };

        return String(value || '')
            .toLowerCase()
            .replace(/[a-z]/g, character => latinToCyrillic[character] || character)
            .replace(/трансграничн\S*/g, ' ')
            .replace(/возврат\s+без\s+причины.*$/g, ' ')
            .replace(/\d+(?:[.,]\d+)?\s*[gг]?/g, ' ')
            .replace(/[^a-zа-яё\u4e00-\u9fff]+/gi, ' ')
            .replace(/(?:^|\s)(?:получено|оценки|оценка|ртв|ть)(?=\s|$)/giu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function textSimilarity(first, second) {
        if (first === second) return first ? 1 : 0;
        if (!first || !second) return 0;

        const previous = Array.from({ length: second.length + 1 }, (_, index) => index);

        for (let firstIndex = 1; firstIndex <= first.length; firstIndex++) {
            const current = [firstIndex];

            for (let secondIndex = 1; secondIndex <= second.length; secondIndex++) {
                current[secondIndex] = Math.min(
                    current[secondIndex - 1] + 1,
                    previous[secondIndex] + 1,
                    previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)
                );
            }

            for (let index = 0; index < current.length; index++) previous[index] = current[index];
        }

        return 1 - previous[second.length] / Math.max(first.length, second.length);
    }

    function overlappingItemsMatch(first, second) {
        if (!first || !second) return false;
        if (Number(first.quantity) !== Number(second.quantity)) return false;
        if (Math.abs(Number(first.price) - Number(second.price)) > 0.01) return false;

        const firstDescription = normalizeOverlapDescription(first.description);
        const secondDescription = normalizeOverlapDescription(second.description);
        if (Math.min(firstDescription.length, secondDescription.length) < 5) return false;

        return textSimilarity(firstDescription, secondDescription) >= 0.72;
    }

    function mergeScreenshotItems(existingItems, nextItems) {
        const existing = [...(existingItems || [])];
        const next = [...(nextItems || [])];
        const maximumOverlap = Math.min(existing.length, next.length, 6);
        let overlap = 0;

        for (let size = maximumOverlap; size > 0; size--) {
            const existingStart = existing.length - size;
            const matches = next
                .slice(0, size)
                .every((item, index) => overlappingItemsMatch(existing[existingStart + index], item));

            if (matches) {
                overlap = size;
                break;
            }
        }

        return {
            items: existing.concat(next.slice(overlap)),
            removed: overlap
        };
    }

    return {
        allocateMoney,
        mergeScreenshotItems,
        numberFromText,
        parseOrderScreenshotTsv,
        parseTsvWords
    };
});

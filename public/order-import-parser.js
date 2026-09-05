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
        const match = compact.match(/^[xхХ×][xхХ×]?(\d{1,4})$/i);
        if (!match) return null;

        const quantity = Number.parseInt(match[1], 10);
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

    function descriptionForItem(index, anchors, prices, lines, imageWidth, summaryY) {
        const price = prices[index];
        if (!price) return '';

        const startY = price.amount.y - 4;
        const nextBoundary = index < anchors.length - 1
            ? (anchors[index].centerY + anchors[index + 1].centerY) / 2
            : summaryY;
        const endY = Number.isFinite(nextBoundary)
            ? nextBoundary
            : anchors[index].centerY + imageWidth * 0.34;

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

        const nearby = joinedNearbyText(lines, index, imageHeight);
        const yuanMatches = [...nearby.matchAll(/(-?\d+[.,]\d{1,3})\s*[¥￥]/g)]
            .map(match => numberFromText(match[1]))
            .filter(value => value !== null);

        if (yuanMatches.length > 0) return roundMoney(yuanMatches[yuanMatches.length - 1]);

        const amounts = decimalsFromText(nearby);
        if (amounts.length >= 2) return roundMoney(amounts[amounts.length - 1]);
        return null;
    }

    function parseOrderScreenshotTsv(tsv, imageWidth, imageHeight) {
        const words = parseTsvWords(tsv);
        const lines = buildLines(words);
        const anchors = findQuantityAnchors(words, imageWidth);
        const prices = anchors.map(anchor => priceForAnchor(anchor, lines, imageWidth));
        const lastAnchorY = anchors.length > 0 ? anchors[anchors.length - 1].centerY : imageHeight * 0.45;
        const summaryLine = lines.find(line => line.centerY > lastAnchorY && SUMMARY_PATTERN.test(line.text));
        const summaryY = summaryLine ? summaryLine.top : imageHeight;

        const items = anchors
            .map((anchor, index) => {
                const price = prices[index];
                if (!price) return null;

                return {
                    quantity: anchor.quantity,
                    price: roundMoney(price.amount.value),
                    description: descriptionForItem(index, anchors, prices, lines, imageWidth, summaryY),
                    crop: photoCropForPrice(price, imageWidth, imageHeight),
                    confidence: Math.round((anchor.confidence + price.amount.confidence) / 2)
                };
            })
            .filter(Boolean);

        const freight = freightFromLines(lines, lastAnchorY);
        const processingFee = feeFromLines(lines, lastAnchorY, imageHeight);
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

    return {
        allocateMoney,
        numberFromText,
        parseOrderScreenshotTsv,
        parseTsvWords
    };
});

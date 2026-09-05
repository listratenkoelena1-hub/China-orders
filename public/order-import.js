(function () {
    'use strict';

    const OCR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
    const IMPORT_CANVAS_MAX_WIDTH = 900;
    const IMPORT_PHOTO_SIZE = 240;
    const IMPORT_PHOTO_QUALITY = 0.76;

    let ocrLibraryPromise = null;
    let importProcessing = false;
    let replacementPhotoIndex = -1;
    let importProgressContext = { fileIndex: 0, fileCount: 1 };
    let pendingImportMode = 'replace';
    let retryImportMode = 'replace';
    let toastTimeout;
    let importState = emptyImportState();

    function emptyImportState() {
        return {
            items: [],
            freight: '',
            processingFee: '',
            warnings: [],
            sourceCount: 0
        };
    }

    function parserApi() {
        return window.ChinaOrdersImportParser;
    }

    function escapeImportHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function importMoney(value) {
        const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
        return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }

    function roundImportMoney(value) {
        return Math.round((Number(value) || 0) * 100) / 100;
    }

    function importNumberInput(value, digits = 2) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '';
        return digits === 0 ? String(Math.max(0, Math.round(number))) : number.toFixed(digits);
    }

    function setImportView(name) {
        const views = {
            start: document.getElementById('orderImportStartView'),
            processing: document.getElementById('orderImportProcessingView'),
            review: document.getElementById('orderImportReviewView')
        };

        Object.entries(views).forEach(([key, element]) => {
            element?.classList.toggle('hidden', key !== name);
        });

        document.getElementById('orderImportFooter')?.classList.toggle('hidden', name !== 'review');
    }

    function setImportProgress(percent, title, detail = '') {
        const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
        const bar = document.getElementById('orderImportProgressBar');
        const titleElement = document.getElementById('orderImportProgressTitle');
        const detailElement = document.getElementById('orderImportProgressText');

        if (bar) bar.style.width = `${safePercent}%`;
        if (titleElement && title) titleElement.innerText = title;
        if (detailElement) detailElement.innerText = detail;
    }

    function translatedOcrStatus(status) {
        const statuses = {
            'loading tesseract core': 'Загружаю распознавание…',
            'initializing tesseract': 'Подготавливаю распознавание…',
            'loading language traineddata': 'Загружаю языки…',
            'initializing api': 'Почти готово…',
            'recognizing text': 'Читаю скриншот…'
        };

        return statuses[status] || 'Обрабатываю скриншот…';
    }

    function handleOcrProgress(message) {
        const fileCount = Math.max(1, importProgressContext.fileCount);
        const fileIndex = Math.max(0, importProgressContext.fileIndex);
        const phaseProgress = Math.max(0, Math.min(1, Number(message?.progress) || 0));
        const overall = Math.round(((fileIndex + phaseProgress) / fileCount) * 100);
        const fileLabel = `Изображение ${Math.min(fileIndex + 1, fileCount)} из ${fileCount}`;

        setImportProgress(overall, translatedOcrStatus(message?.status), fileLabel);
    }

    function loadOcrLibrary() {
        if (window.Tesseract) return Promise.resolve(window.Tesseract);
        if (ocrLibraryPromise) return ocrLibraryPromise;

        ocrLibraryPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = OCR_SCRIPT_URL;
            script.async = true;
            script.crossOrigin = 'anonymous';
            script.onload = () => {
                if (window.Tesseract) {
                    resolve(window.Tesseract);
                } else {
                    reject(new Error('Модуль распознавания загрузился некорректно. Обновите страницу и попробуйте снова.'));
                }
            };
            script.onerror = () => reject(new Error('Не удалось загрузить модуль распознавания. Проверьте интернет и попробуйте ещё раз.'));
            document.head.appendChild(script);
        }).catch(error => {
            ocrLibraryPromise = null;
            throw error;
        });

        return ocrLibraryPromise;
    }

    function imageCanvasFromFile(file) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            const objectUrl = URL.createObjectURL(file);

            image.onload = () => {
                URL.revokeObjectURL(objectUrl);

                const naturalWidth = image.naturalWidth || image.width;
                const naturalHeight = image.naturalHeight || image.height;
                const scale = Math.min(1, IMPORT_CANVAS_MAX_WIDTH / naturalWidth);
                const canvas = document.createElement('canvas');

                canvas.width = Math.max(1, Math.round(naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(naturalHeight * scale));

                const context = canvas.getContext('2d');
                context.imageSmoothingEnabled = true;
                context.imageSmoothingQuality = 'high';
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                resolve(canvas);
            };

            image.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error(`Не удалось открыть изображение «${file.name || 'без названия'}».`));
            };

            image.src = objectUrl;
        });
    }

    function cropImportPhoto(sourceCanvas, crop) {
        if (!crop) return '';

        const left = Math.max(0, Math.min(sourceCanvas.width - 1, Math.round(crop.left)));
        const top = Math.max(0, Math.min(sourceCanvas.height - 1, Math.round(crop.top)));
        const width = Math.max(1, Math.min(sourceCanvas.width - left, Math.round(crop.width)));
        const height = Math.max(1, Math.min(sourceCanvas.height - top, Math.round(crop.height)));
        const output = document.createElement('canvas');

        output.width = IMPORT_PHOTO_SIZE;
        output.height = IMPORT_PHOTO_SIZE;

        const context = output.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, output.width, output.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(sourceCanvas, left, top, width, height, 0, 0, output.width, output.height);

        return output.toDataURL('image/jpeg', IMPORT_PHOTO_QUALITY);
    }

    function uniqueMoneyValues(values) {
        return [...new Set(values.map(value => roundImportMoney(value).toFixed(2)))];
    }

    async function processImportFiles(files, options = {}) {
        const imageFiles = [...files].filter(file => String(file.type || '').startsWith('image/'));
        if (imageFiles.length === 0 || importProcessing) return;

        const appendToCurrent = Boolean(options.append);
        const existingItems = appendToCurrent ? [...importState.items] : [];
        const existingWarnings = appendToCurrent ? [...importState.warnings] : [];
        const existingSourceCount = appendToCurrent ? importState.sourceCount : 0;
        const existingFreight = appendToCurrent
            ? (document.getElementById('orderImportFreight')?.value ?? importState.freight)
            : '';
        const existingFee = appendToCurrent
            ? (document.getElementById('orderImportFee')?.value ?? importState.processingFee)
            : '';

        if (!appendToCurrent) importState = emptyImportState();
        importProcessing = true;

        const closeButton = document.getElementById('orderImportCloseBtn');
        const retryButton = document.getElementById('orderImportRetryBtn');
        const errorElement = document.getElementById('orderImportError');
        if (closeButton) closeButton.disabled = true;
        if (retryButton) retryButton.classList.add('hidden');
        if (errorElement) errorElement.innerText = '';

        setImportView('processing');
        setImportProgress(
            0,
            appendToCurrent ? 'Добавляю скриншоты…' : 'Подготавливаю распознавание…',
            appendToCurrent
                ? 'Уже найденные и исправленные товары сохранятся.'
                : 'Первый запуск может занять немного больше времени.'
        );

        let worker = null;
        const freightValues = [];
        const feeValues = [];
        const batchWarnings = [];
        let batchItems = [];
        let removedOverlaps = 0;

        try {
            const parser = parserApi();
            if (!parser) throw new Error('Модуль разбора заказа не загрузился. Обновите страницу и попробуйте снова.');

            const Tesseract = await loadOcrLibrary();
            importProgressContext = { fileIndex: 0, fileCount: imageFiles.length };
            worker = await Tesseract.createWorker(['eng', 'rus'], 1, { logger: handleOcrProgress });

            for (let index = 0; index < imageFiles.length; index++) {
                importProgressContext = { fileIndex: index, fileCount: imageFiles.length };
                setImportProgress(
                    Math.round(index / imageFiles.length * 100),
                    'Читаю скриншот…',
                    `Изображение ${index + 1} из ${imageFiles.length}`
                );

                const canvas = await imageCanvasFromFile(imageFiles[index]);
                const result = await worker.recognize(canvas, {}, { text: true, tsv: true });
                const parsed = parser.parseOrderScreenshotTsv(result.data.tsv, canvas.width, canvas.height);

                const screenshotItems = parsed.items.map(item => ({
                        description: item.description || '',
                        quantity: item.quantity || 1,
                        price: item.price || 0,
                        photo: cropImportPhoto(canvas, item.crop),
                        confidence: item.confidence || 0
                    }));
                const merged = parser.mergeScreenshotItems
                    ? parser.mergeScreenshotItems(batchItems, screenshotItems)
                    : { items: batchItems.concat(screenshotItems), removed: 0 };
                batchItems = merged.items;
                removedOverlaps += merged.removed;

                if (parsed.freight !== null) freightValues.push(parsed.freight);
                if (parsed.processingFee !== null) feeValues.push(parsed.processingFee);
                if (parsed.items.length === 0) {
                    batchWarnings.push(`На изображении ${index + 1} товары не распознаны.`);
                }
            }

            importState.items = existingItems.concat(batchItems);
            importState.sourceCount = existingSourceCount + imageFiles.length;
            importState.freight = appendToCurrent && existingFreight !== ''
                ? existingFreight
                : (freightValues.length > 0 ? freightValues[freightValues.length - 1] : '');
            importState.processingFee = appendToCurrent && existingFee !== ''
                ? existingFee
                : (feeValues.length > 0 ? feeValues[feeValues.length - 1] : '');
            importState.warnings = batchWarnings;

            const comparedFreightValues = [...freightValues];
            const comparedFeeValues = [...feeValues];
            if (appendToCurrent && existingFreight !== '') comparedFreightValues.unshift(importMoney(existingFreight));
            if (appendToCurrent && existingFee !== '') comparedFeeValues.unshift(importMoney(existingFee));

            if (importState.freight === '') {
                importState.warnings.push('Фрахт не распознан — введите его вручную.');
            } else if (uniqueMoneyValues(comparedFreightValues).length > 1) {
                importState.warnings.push('На скриншотах найдены разные суммы фрахта. Проверьте выбранное значение.');
            }

            if (importState.processingFee === '') {
                importState.warnings.push('Комиссия в юанях не распознана — при необходимости введите её вручную.');
            } else if (uniqueMoneyValues(comparedFeeValues).length > 1) {
                importState.warnings.push('На скриншотах найдены разные комиссии. Проверьте выбранное значение.');
            }

            if (removedOverlaps > 0) {
                importState.warnings.push(`Автоматически убраны повторы на соседних скриншотах: ${removedOverlaps}.`);
            }
            if (appendToCurrent) {
                importState.warnings.push(
                    `С новых скриншотов добавлено товаров: ${batchItems.length}. Повторы с прежними позициями оставлены — их можно удалить крестиком.`
                );
            }
            setImportProgress(100, 'Готово', 'Показываю распознанные данные.');
            renderImportReview();
            setImportView('review');
        } catch (error) {
            console.error('Order screenshot import error', error);
            if (appendToCurrent) {
                importState.items = existingItems;
                importState.freight = existingFreight;
                importState.processingFee = existingFee;
                importState.sourceCount = existingSourceCount;
                importState.warnings = existingWarnings.concat('Новые скриншоты не удалось обработать. Уже найденные товары сохранены.');
                renderImportReview();
                setImportView('review');
            } else {
                if (errorElement) {
                    errorElement.innerText = error?.message || 'Не удалось распознать скриншот. Попробуйте ещё раз.';
                }
                if (retryButton) retryButton.classList.remove('hidden');
                setImportProgress(0, 'Не удалось распознать', 'Скриншот не был добавлен в таблицу.');
            }
        } finally {
            if (worker) {
                try {
                    await worker.terminate();
                } catch (error) {
                    console.warn('OCR worker cleanup error', error);
                }
            }

            importProcessing = false;
            if (closeButton) closeButton.disabled = false;
        }
    }

    function importFinancials() {
        const freightInput = document.getElementById('orderImportFreight');
        const feeInput = document.getElementById('orderImportFee');
        const freight = importMoney(freightInput?.value ?? importState.freight);
        const processingFee = importMoney(feeInput?.value ?? importState.processingFee);
        const total = roundImportMoney(freight + processingFee);
        const weights = importState.items.map(item => importMoney(item.quantity) * importMoney(item.price));
        const allocations = parserApi().allocateMoney(total, weights);

        return { freight, processingFee, total, allocations };
    }

    function renderImportWarnings() {
        const warningElement = document.getElementById('orderImportWarnings');
        if (!warningElement) return;

        const uniqueWarnings = [...new Set(importState.warnings.filter(Boolean))];
        warningElement.innerHTML = uniqueWarnings
            .map(warning => `<div>• ${escapeImportHtml(warning)}</div>`)
            .join('');
    }

    function renderImportItems() {
        const container = document.getElementById('orderImportItems');
        if (!container) return;

        if (importState.items.length === 0) {
            container.innerHTML = '<div class="order-import-empty-items">Товары пока не добавлены. Можно создать строку вручную.</div>';
            return;
        }

        container.innerHTML = importState.items.map((item, index) => `
            <article class="order-import-item">
                <button class="order-import-photo" type="button" onclick="chooseOrderImportPhoto(${index})" title="Заменить фото">
                    ${item.photo
                        ? `<img src="${escapeImportHtml(item.photo)}" alt="Фото товара ${index + 1}">`
                        : '<span class="order-import-photo-placeholder">Нажмите, чтобы выбрать фото</span>'}
                </button>
                <div class="order-import-item-fields">
                    <textarea class="order-import-description" aria-label="Описание товара ${index + 1}" oninput="updateOrderImportItem(${index}, 'description', this.value)">${escapeImportHtml(item.description)}</textarea>
                    <div class="order-import-numbers">
                        <label class="order-import-field">
                            <span>Количество</span>
                            <input type="number" min="1" step="1" inputmode="numeric" value="${importNumberInput(item.quantity, 0)}" oninput="updateOrderImportItem(${index}, 'quantity', this.value)">
                        </label>
                        <label class="order-import-field">
                            <span>Цена за единицу, ¥</span>
                            <input type="number" min="0" step="0.01" inputmode="decimal" value="${importNumberInput(item.price)}" oninput="updateOrderImportItem(${index}, 'price', this.value)">
                        </label>
                        <label class="order-import-field">
                            <span>Доставка, ¥</span>
                            <output id="orderImportDelivery${index}">0.00</output>
                        </label>
                    </div>
                </div>
                <button class="order-import-remove" type="button" onclick="removeOrderImportItem(${index})" aria-label="Удалить товар ${index + 1}">×</button>
            </article>
        `).join('');
    }

    function renderImportReview() {
        renderImportItems();

        const freightInput = document.getElementById('orderImportFreight');
        const feeInput = document.getElementById('orderImportFee');
        const reviewText = document.getElementById('orderImportReviewText');

        if (freightInput) freightInput.value = importState.freight === '' ? '' : importNumberInput(importState.freight);
        if (feeInput) feeInput.value = importState.processingFee === '' ? '' : importNumberInput(importState.processingFee);
        if (reviewText) {
            reviewText.innerText = `Найдено товаров: ${importState.items.length}. Проверьте данные — серые первоначальные цены и скидка повторно не добавляются.`;
        }

        renderImportWarnings();
        refreshImportTotals();
    }

    function refreshImportTotals() {
        const financials = importFinancials();
        const totalElement = document.getElementById('orderImportShippingTotal');
        const applyButton = document.getElementById('orderImportApplyBtn');

        if (totalElement) totalElement.innerText = `${financials.total.toFixed(2)} ¥`;

        financials.allocations.forEach((value, index) => {
            const output = document.getElementById(`orderImportDelivery${index}`);
            if (output) output.innerText = value.toFixed(2);
        });

        const hasInvalidItems = importState.items.some(item => (
            importMoney(item.quantity) <= 0 || !Number.isFinite(Number(item.price)) || Number(item.price) < 0
        ));

        if (applyButton) applyButton.disabled = importState.items.length === 0 || hasInvalidItems;
    }

    function rowIsEmptyForImport(row) {
        if (!row) return false;
        const hasPhoto = Boolean(row.children[2]?.querySelector('img'));
        const hasEditableData = [1, 3, 4, 6].some(index => {
            const cell = row.children[index];
            return String(cell?.innerText ?? cell?.textContent ?? '').trim();
        });
        return !hasPhoto && !hasEditableData;
    }

    function targetRowsForImport(count) {
        let rows = [...document.querySelectorAll('#tbody tr')];
        let emptyRows = rows.filter(rowIsEmptyForImport);

        while (emptyRows.length < count) {
            addRow();
            rows = [...document.querySelectorAll('#tbody tr')];
            emptyRows = rows.filter(rowIsEmptyForImport);
        }

        return emptyRows.slice(0, count);
    }

    function showImportToast(message) {
        const toast = document.getElementById('orderImportToast');
        if (!toast) return;

        clearTimeout(toastTimeout);
        toast.innerText = message;
        toast.classList.add('show');
        toastTimeout = setTimeout(() => toast.classList.remove('show'), 2600);
    }

    window.openOrderImport = function () {
        if (typeof closeCalc === 'function') closeCalc();
        importState = emptyImportState();
        replacementPhotoIndex = -1;
        pendingImportMode = 'replace';
        retryImportMode = 'replace';

        const modal = document.getElementById('orderImportModal');
        const errorElement = document.getElementById('orderImportError');
        const retryButton = document.getElementById('orderImportRetryBtn');
        if (errorElement) errorElement.innerText = '';
        if (retryButton) retryButton.classList.add('hidden');
        if (modal) modal.classList.remove('hidden');
        document.body.classList.add('order-import-open');
        setImportView('start');
    };

    window.closeOrderImport = function () {
        if (importProcessing) return;

        document.getElementById('orderImportModal')?.classList.add('hidden');
        document.body.classList.remove('order-import-open');
        importState = emptyImportState();
        replacementPhotoIndex = -1;
        pendingImportMode = 'replace';
        retryImportMode = 'replace';
    };

    function chooseOrderImportScreenshotsForMode(mode) {
        if (importProcessing) return;
        const input = document.getElementById('orderImportFileInput');
        if (!input) return;
        pendingImportMode = mode;
        input.value = '';
        input.click();
    }

    window.chooseOrderImportScreenshots = function () {
        chooseOrderImportScreenshotsForMode('replace');
    };

    window.chooseAdditionalOrderImportScreenshots = function () {
        chooseOrderImportScreenshotsForMode('append');
    };

    window.retryOrderImportScreenshots = function () {
        chooseOrderImportScreenshotsForMode(retryImportMode);
    };

    window.handleOrderImportFiles = function (fileList) {
        const files = [...(fileList || [])];
        const mode = pendingImportMode;
        const input = document.getElementById('orderImportFileInput');
        if (input) input.value = '';
        retryImportMode = mode;
        processImportFiles(files, { append: mode === 'append' });
    };

    window.updateOrderImportItem = function (index, field, value) {
        const item = importState.items[index];
        if (!item) return;

        if (field === 'description') {
            item.description = value;
        } else if (field === 'quantity') {
            item.quantity = Math.max(0, Math.round(importMoney(value)));
        } else if (field === 'price') {
            item.price = importMoney(value);
        }

        refreshImportTotals();
    };

    window.updateOrderImportTotals = function () {
        const freightInput = document.getElementById('orderImportFreight');
        const feeInput = document.getElementById('orderImportFee');
        importState.freight = freightInput?.value ?? '';
        importState.processingFee = feeInput?.value ?? '';
        refreshImportTotals();
    };

    window.removeOrderImportItem = function (index) {
        importState.items.splice(index, 1);
        renderImportItems();
        refreshImportTotals();
    };

    window.addOrderImportItem = function () {
        importState.items.push({
            description: '',
            quantity: 1,
            price: 0,
            photo: '',
            confidence: 100
        });
        renderImportItems();
        refreshImportTotals();
    };

    window.chooseOrderImportPhoto = function (index) {
        replacementPhotoIndex = index;
        const input = document.getElementById('orderImportPhotoInput');
        if (!input) return;
        input.value = '';
        input.click();
    };

    window.handleOrderImportPhoto = async function (fileList) {
        const file = [...(fileList || [])][0];
        const input = document.getElementById('orderImportPhotoInput');
        if (input) input.value = '';
        if (!file || replacementPhotoIndex < 0 || !importState.items[replacementPhotoIndex]) return;

        try {
            importState.items[replacementPhotoIndex].photo = await compressPhotoFile(file);
            renderImportItems();
            refreshImportTotals();
        } catch (error) {
            console.error('Import photo replacement error', error);
            importState.warnings.push('Не удалось заменить одно из изображений.');
            renderImportWarnings();
        }
    };

    window.applyOrderImport = function () {
        if (importState.items.length === 0) return;

        const financials = importFinancials();
        const targetRows = targetRowsForImport(importState.items.length);

        importState.items.forEach((item, index) => {
            const row = targetRows[index];
            if (!row) return;

            row.children[1].innerText = item.description || '';
            row.children[2].innerHTML = '';

            if (item.photo) {
                const image = document.createElement('img');
                image.src = item.photo;
                image.alt = '';
                row.children[2].appendChild(image);
            }

            row.children[3].innerText = String(Math.max(1, Math.round(importMoney(item.quantity))));
            row.children[4].innerText = importMoney(item.price).toFixed(2);
            row.children[6].innerText = financials.allocations[index].toFixed(2);
        });

        const itemCount = importState.items.length;
        recalc();
        window.closeOrderImport();
        showImportToast(`Добавлено товаров: ${itemCount}`);
    };

    document.getElementById('orderImportModal')?.addEventListener('click', event => {
        if (event.target.id === 'orderImportModal') window.closeOrderImport();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !document.getElementById('orderImportModal')?.classList.contains('hidden')) {
            window.closeOrderImport();
        }
    });
})();

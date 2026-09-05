const assert = require('node:assert/strict');
const parser = require('../public/order-import-parser.js');

const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
let lineNumber = 0;

function tsvLine(y, words) {
    lineNumber++;
    return words.map((word, index) => [
        5, 1, 1, 1, lineNumber, index + 1,
        word.x, y, word.width || 70, word.height || 18,
        word.confidence || 95, word.text
    ].join('\t')).join('\n');
}

function screenshotTsv() {
    lineNumber = 0;
    return [
        header,
        tsvLine(200, [
            { x: 175, width: 130, text: 'Товар один' },
            { x: 532, width: 42, text: '6.00' }
        ]),
        tsvLine(232, [{ x: 538, width: 35, text: '6.00' }]),
        tsvLine(267, [{ x: 558, width: 15, text: 'x' }]),
        tsvLine(400, [
            { x: 175, width: 130, text: 'Товар два' },
            { x: 532, width: 42, text: '8.20' }
        ]),
        tsvLine(432, [{ x: 538, width: 35, text: '8.20' }]),
        tsvLine(467, [{ x: 558, width: 15, text: 'xi' }]),
        tsvLine(850, [{ x: 500, width: 64, text: '¥81.15' }]),
        tsvLine(897, [{ x: 529, width: 36, text: '8.00' }]),
        tsvLine(943, [
            { x: 425, width: 34, text: '0,41' },
            { x: 468, width: 71, text: '$(#92,71' }
        ]),
        tsvLine(997, [{ x: 506, width: 68, text: '89.15' }])
    ].join('\n');
}

const parsed = parser.parseOrderScreenshotTsv(screenshotTsv(), 590, 1280);
assert.equal(parsed.items.length, 2, 'price pairs should recover products even when x1 is missing or malformed');
assert.deepEqual(parsed.items.map(item => item.quantity), [1, 1]);
assert.deepEqual(parsed.items.map(item => item.price), [6, 8.2]);
assert.equal(parsed.freight, 8);
assert.equal(parsed.processingFee, 2.71);
assert.deepEqual(parsed.warnings, []);

const screenshots = [
    [
        ['Эксклюзивная Кармин', 1, 0.95],
        ['Цвет покрытия Аврора', 1, 8.2],
        ['Трансграничный тонкий зеленый 0.29', 1, 6],
        ['Трансграничный Тонда Неба 0.29', 1, 6]
    ],
    [
        ['Трансграничный Torna Неба 0.2g', 1, 6],
        ['Трансграничный закат оранжевый 0.2g', 1, 6],
        ['Трансграничный Фантом Фиолетовый', 1, 6],
        ['Трансграничный лед персикового цвета', 1, 6],
        ['Трансграничный межзвездный синий', 1, 6]
    ],
    [
        ['Трансграничный Глирия 0.29', 1, 6],
        ['Трансграничный Солнечный Цзиньшань', 1, 6],
        ['Трансграничный снежная парча 0.29', 1, 6],
        ['Трансграничный белое персиковое сладкое вино 0.2g', 1, 6],
        ['Трансграничный персиковый цвет 0.29 оценки ть', 1, 6]
    ],
    [
        ['Трансграничный белое персиковое сладкое вино 0.29 РТВ', 1, 6],
        ['Трансграничный персиковый цвет 0.29', 1, 6],
        ['Трансграничный Храм поднимающегося солнца 0.2g', 1, 6]
    ]
].map(screenshot => screenshot.map(([description, quantity, price]) => ({ description, quantity, price })));

let mergedItems = [];
let removedItems = 0;

screenshots.forEach(screenshot => {
    const merged = parser.mergeScreenshotItems(mergedItems, screenshot);
    mergedItems = merged.items;
    removedItems += merged.removed;
});

assert.equal(removedItems, 3, 'three adjacent screenshot overlaps should be removed');
assert.equal(mergedItems.length, 14, 'the four supplied screenshots contain fourteen unique products');

const allocations = parser.allocateMoney(10.71, mergedItems.map(item => item.quantity * item.price));
assert.equal(Math.round(allocations.reduce((sum, value) => sum + value, 0) * 100), 1071);

console.log('order-import-parser tests passed');

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJcamp } from '../src/jcamp.mjs';

const RECEIPT = 'a'.repeat(64);

function parse(text) {
  return parseJcamp(Buffer.from(text, 'utf8'), RECEIPT);
}

function pointsOf(result, blockTitle) {
  return result.records
    .filter(record => record.kind === 'spectral-point' && record.value.block === blockTitle)
    .map(record => record.value);
}

function blockOf(result, title) {
  const record = result.records.find(record => record.kind === 'spectrum-block' && record.value.title === title);
  return record?.value;
}

test('AFFN XYPOINTS 逐点读数并保留独立单位与因子', () => {
  const result = parse([
    '##TITLE=standalone',
    '##JCAMP-DX=5.01',
    '##DATA TYPE=INFRARED SPECTRUM',
    '##XUNITS=1/CM',
    '##YUNITS=TRANSMITTANCE',
    '##XFACTOR=2',
    '##YFACTOR=0.5',
    '##NPOINTS=2',
    '##XYPOINTS=(XY..XY)',
    '1,10 3,20',
    '##END='
  ].join('\n'));
  assert.deepEqual(pointsOf(result, 'standalone'), [
    { block: 'standalone', index: 0, x: 2, y: 5 },
    { block: 'standalone', index: 1, x: 6, y: 10 }
  ]);
  assert.deepEqual(blockOf(result, 'standalone').xUnits, '1/CM');
  assert.deepEqual(blockOf(result, 'standalone').yUnits, 'TRANSMITTANCE');
});

test('SQZ 编码的 XYDATA 按 YFACTOR 缩放', () => {
  const result = parse([
    '##TITLE=sqz',
    '##XUNITS=1/CM',
    '##YUNITS=ABSORBANCE',
    '##XFACTOR=1',
    '##YFACTOR=0.1',
    '##FIRSTX=0',
    '##LASTX=3',
    '##DELTAX=1',
    '##NPOINTS=4',
    '##XYDATA=(X++(Y..Y))',
    '0 A0 B C D',
    '##END='
  ].join('\n'));
  // A0=10、B=2、C=3、D=4，分别乘 0.1。
  assert.deepEqual(pointsOf(result, 'sqz').map(point => point.y), [1, 0.2, 0.3, 0.4]);
  assert.equal(blockOf(result, 'sqz').compression, 'PACKED');
});

test('PAC 含小数点的记号打包多个数', () => {
  // 每个数以字母为个位、小数点分位：E=5、B=2、C=3。
  const result = parse([
    '##TITLE=pac',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=3',
    '##XYDATA=(X++(Y..Y))',
    '0 E.B.C',
    '##END='
  ].join('\n'));
  assert.deepEqual(pointsOf(result, 'pac').map(point => point.y), [5, 2, 3]);
  // 高位写在个位字母之前：5B. 表示 52；下一个字母 C 另起一数 3。
  const packed = parse([
    '##TITLE=pac2',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=2',
    '##XYDATA=(X++(Y..Y))',
    '0 5B.C',
    '##END='
  ].join('\n'));
  assert.deepEqual(pointsOf(packed, 'pac2').map(point => point.y), [52, 3]);
  // 小数部分写在小数点之后。
  const decimals = parse([
    '##TITLE=pac3',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=1',
    '##XYDATA=(X++(Y..Y))',
    '0 B.5',
    '##END='
  ].join('\n'));
  assert.deepEqual(pointsOf(decimals, 'pac3').map(point => point.y), [2.5]);
});

test('DIF 跨行差分延续，行首检查点只复核不计入观测', () => {
  const result = parse([
    '##TITLE=dif',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=6',
    '##XYDATA=(X++(Y..Y))',
    '0 A0 J J J',
    '3 A3 J J',
    '##END='
  ].join('\n'));
  // 初始 10，差分 +1 重复五次 => 10..15；第二行行首 A3 是检查点。
  assert.deepEqual(pointsOf(result, 'dif').map(point => point.y), [10, 11, 12, 13, 14, 15]);
  assert.equal(blockOf(result, 'dif').receivedPoints, 6);
  assert.equal(result.issues.filter(issue => issue.reason === 'dif-checkpoint-mismatch').length, 0);
});

test('DIF 检查点对不上时保留原表达与影响范围，不猜值凑点', () => {
  const result = parse([
    '##TITLE=broken-dif',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=6',
    '##XYDATA=(X++(Y..Y))',
    '0 A0 J J J',
    '3 A9 J J',
    '##END='
  ].join('\n'));
  const issue = result.issues.find(item => item.reason === 'dif-checkpoint-mismatch');
  assert.ok(issue, '应报告检查点不一致');
  assert.match(issue.location, /^line:8/);
  assert.match(issue.raw, /3 A9 J J/);
  // 首行 4 个读数已核实；第二行检查点复核失败发生在该行任何读数发射之前，
  // 后续差分失去依据，保留原行与影响范围，不补造剩余点。
  assert.deepEqual(pointsOf(result, 'broken-dif').map(point => point.y), [10, 11, 12, 13]);
  assert.equal(blockOf(result, 'broken-dif').receivedPoints, 4);
});

test('DIFDUP 重复字符按前一差分复制', () => {
  const result = parse([
    '##TITLE=difdup',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=5',
    '##XYDATA=(X++(Y..Y))',
    '0 A0 J U',
    '##END='
  ].join('\n'));
  // 10，差分 +1，然后 U 表示再重复 3 次 +1。
  assert.deepEqual(pointsOf(result, 'difdup').map(point => point.y), [10, 11, 12, 13, 14]);
});

test('小写字母编码负数与负差分', () => {
  const negative = parse([
    '##TITLE=neg-sqz',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=2',
    '##XYDATA=(X++(Y..Y))',
    '0 a b',
    '##END='
  ].join('\n'));
  assert.deepEqual(pointsOf(negative, 'neg-sqz').map(point => point.y), [-1, -2]);

  const decreasing = parse([
    '##TITLE=neg-dif',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=4',
    '##XYDATA=(X++(Y..Y))',
    '0 E j j j',
    '##END='
  ].join('\n'));
  // 首值 5，随后每个差分 j=-1。
  assert.deepEqual(pointsOf(decreasing, 'neg-dif').map(point => point.y), [5, 4, 3, 2]);
});

test('LINK 内各块单位不串用，点数各自闭合', () => {
  const result = parse([
    '##TITLE=collection',
    '##DATA TYPE=LINK',
    '##BLOCKS=2',
    '##TITLE=one',
    '##XUNITS=1/CM',
    '##YUNITS=ABSORBANCE',
    '##YFACTOR=0.1',
    '##NPOINTS=1',
    '##XYPOINTS=(XY..XY)',
    '1,5',
    '##END=',
    '##TITLE=two',
    '##XUNITS=NANOMETERS',
    '##YUNITS=TRANSMITTANCE',
    '##YFACTOR=1',
    '##NPOINTS=1',
    '##XYPOINTS=(XY..XY)',
    '2,5',
    '##END=',
    '##END='
  ].join('\n'));
  assert.equal(blockOf(result, 'one').yUnits, 'ABSORBANCE');
  assert.equal(blockOf(result, 'two').yUnits, 'TRANSMITTANCE');
  assert.deepEqual(pointsOf(result, 'one'), [{ block: 'one', index: 0, x: 1, y: 0.5 }]);
  assert.deepEqual(pointsOf(result, 'two'), [{ block: 'two', index: 0, x: 2, y: 5 }]);
});

test('截断文件报告未闭合块与点数不闭合，已读数据仍保留', () => {
  const result = parse([
    '##TITLE=collection',
    '##DATA TYPE=LINK',
    '##BLOCKS=2',
    '##TITLE=partial',
    '##YFACTOR=1',
    '##NPOINTS=5',
    '##XYDATA=(X++(Y..Y))',
    '0 A0 J J'
  ].join('\n'));
  assert.ok(result.issues.some(issue => issue.reason === 'unterminated-block'));
  assert.ok(result.issues.some(issue => issue.reason === 'point-count-mismatch'));
  assert.deepEqual(pointsOf(result, 'partial').map(point => point.y), [10, 11, 12]);
});

test('不支持的表格语法标注范围，原文进入 issue 而不是静默丢弃', () => {
  const result = parse([
    '##TITLE=weird',
    '##NPOINTS=1',
    '##PEAKTABLE=(X++(Y..Y))',
    '0 1',
    '##END='
  ].join('\n'));
  const issue = result.issues.find(item => item.reason === 'unsupported-table-syntax');
  assert.ok(issue);
  assert.match(issue.raw, /PEAKTABLE/);
  assert.match(issue.location, /^line:3/);
});

test('每个读数出处都带原行列与字节区间，且绑定收件', () => {
  const result = parse([
    '##TITLE=trace',
    '##YFACTOR=1',
    '##NPOINTS=1',
    '##XYPOINTS=(XY..XY)',
    '7,9',
    '##END='
  ].join('\n'));
  const point = result.records.find(record => record.kind === 'spectral-point');
  assert.equal(point.provenance.length, 1);
  assert.equal(point.provenance[0].receiptId, RECEIPT);
  assert.match(point.provenance[0].location, /^line:5;col:\d+;byte:\d+-\d+$/);
});

test('未知标签原样留存，不冒充已解释', () => {
  const result = parse([
    '##TITLE=unknown-label',
    '##MY LOCAL NOTE=保留我',
    '##NPOINTS=0',
    '##END='
  ].join('\n'));
  const block = blockOf(result, 'unknown-label');
  assert.deepEqual(block.unknownLabels, [{
    label: 'MY LOCAL NOTE', value: '保留我', location: block.unknownLabels[0].location
  }]);
  assert.match(block.unknownLabels[0].location, /^line:2/);
});

test('BLOCKS 声明与实际块数不一致时报告', () => {
  const result = parse([
    '##TITLE=collection',
    '##DATA TYPE=LINK',
    '##BLOCKS=3',
    '##TITLE=only',
    '##NPOINTS=0',
    '##END=',
    '##END='
  ].join('\n'));
  const issue = result.issues.find(item => item.reason === 'block-count-mismatch');
  assert.ok(issue);
  assert.equal(issue.declaredBlocks, 3);
  assert.equal(issue.receivedBlocks, 1);
});

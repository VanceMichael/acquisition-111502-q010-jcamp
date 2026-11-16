import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseJcamp } from '../src/jcamp.mjs';

const SPECTRAL_HEADER = [
  '##JCAMP-DX=5.01',
  '##DATA TYPE=INFRARED SPECTRUM',
  '##XUNITS=1/CM',
  '##YUNITS=ABSORBANCE'
];

test('LINK 交付逐段解释，差分检查点不重复计入观测', async () => {
  const text = await readFile(new URL('../fixtures/spectra.jdx', import.meta.url), 'utf8');
  const { blocks, issues } = parseJcamp(text);
  assert.deepEqual(issues, []);
  assert.equal(blocks.length, 2);

  const [a, b] = blocks;
  assert.equal(a.value.title, 'sample-a');
  assert.equal(a.value.xUnits, '1/CM');
  assert.equal(a.value.yUnits, 'ABSORBANCE');
  assert.equal(a.value.declaredPoints, 5);
  assert.equal(a.value.receivedPoints, 5);
  assert.deepEqual(a.points.map(point => [point.index, point.x, point.y]), [
    [0, 0, 1], [1, 1, 1.1], [2, 2, 1.2], [3, 3, 1.3], [4, 4, 1.4]
  ]);
  assert.ok(Object.is(a.points[4].y, 1.4), '14 × 0.1 应得到精确的 1.4');
  assert.equal(a.points[4].location, 'line:18,token:4');
  assert.equal(a.points[0].location, 'line:17,token:2');
  assert.equal(a.startLine, 5);
  assert.equal(a.endLine, 19);

  assert.equal(b.value.title, 'sample-b');
  assert.equal(b.value.yUnits, 'TRANSMITTANCE');
  assert.equal(b.value.declaredPoints, 2);
  assert.equal(b.value.receivedPoints, 2);
  assert.deepEqual(b.points.map(point => [point.index, point.x, point.y]), [[0, 1, 7], [1, 2, 8]]);
  assert.equal(b.points[0].location, 'line:29,token:1');
});

test('单位与缩放不跨段串扰', async () => {
  const text = await readFile(new URL('../fixtures/spectra.jdx', import.meta.url), 'utf8');
  const { blocks } = parseJcamp(text);
  assert.equal(blocks[0].value.yFactor, 0.1);
  assert.equal(blocks[1].value.yFactor, 1);
  assert.deepEqual(blocks[1].points.map(point => point.y), [7, 8], '第二段不应沿用第一段的 YFACTOR');
});

test('截断交付留下问题说明而不猜造点数', async () => {
  const text = await readFile(new URL('../fixtures/spectra.jdx.partial', import.meta.url), 'utf8');
  const { blocks, issues } = parseJcamp(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].value.declaredPoints, 5);
  assert.equal(blocks[0].value.receivedPoints, 4);
  assert.deepEqual(blocks[0].points.map(point => point.y), [1, 1.1, 1.2, 1.3]);
  const reasons = issues.map(issue => issue.reason);
  assert.ok(reasons.includes('point_count_mismatch'), '应说明声明点数未闭合');
  assert.ok(reasons.includes('truncated_block'), '应说明块未闭合');
  for (const issue of issues) assert.ok(issue.reason && issue.location, '问题需含原因与范围');
});

test('跨行检查值不符时留下记录并按检查点重新锚定', () => {
  const text = [
    '##TITLE=t',
    ...SPECTRAL_HEADER,
    '##XFACTOR=1',
    '##YFACTOR=0.1',
    '##FIRSTX=0',
    '##LASTX=4',
    '##DELTAX=1',
    '##NPOINTS=5',
    '##XYDATA=(X++(Y..Y))',
    '0 A0 J J',
    '2 B0 J J',
    '##END='
  ].join('\n');
  const { blocks, issues } = parseJcamp(text);
  assert.deepEqual(blocks[0].points.map(point => point.y), [1, 1.1, 1.2, 2.1, 2.2]);
  const mismatch = issues.find(issue => issue.reason === 'checkpoint_mismatch');
  assert.ok(mismatch, '检查点不符应留下记录');
  assert.match(mismatch.location, /^line:14,token:2$/);
  assert.equal(issues.filter(issue => issue.reason !== 'checkpoint_mismatch').length, 0);
});

test('损坏记号中断差分链，后续差分不靠猜值补齐', () => {
  const text = [
    '##TITLE=t',
    ...SPECTRAL_HEADER,
    '##XFACTOR=1',
    '##YFACTOR=0.1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=4',
    '##XYDATA=(X++(Y..Y))',
    '0 A0 J ? J',
    '##END='
  ].join('\n');
  const { blocks, issues } = parseJcamp(text);
  assert.deepEqual(blocks[0].points.map(point => point.y), [1, 1.1]);
  const reasons = issues.map(issue => issue.reason);
  assert.ok(reasons.includes('undecodable_token'));
  assert.ok(reasons.includes('dif_without_base'));
  assert.ok(reasons.includes('point_count_mismatch'));
});

test('不支持的表格表达保留原表达与影响范围', () => {
  const text = [
    '##TITLE=t',
    ...SPECTRAL_HEADER,
    '##XFACTOR=1',
    '##YFACTOR=1',
    '##NPOINTS=3',
    '##XYDATA=(XYZ..XYZ)',
    '1 2 3',
    '##END='
  ].join('\n');
  const { blocks, issues } = parseJcamp(text);
  assert.equal(blocks[0].value.receivedPoints, 0);
  const issue = issues.find(entry => entry.reason === 'unsupported_table_format');
  assert.ok(issue, '应报告不支持的表格表达');
  assert.match(issue.detail, /\(XYZ\.\.XYZ\)/);
  assert.ok(issue.excerpt.includes('##XYDATA=(XYZ..XYZ)') && issue.excerpt.includes('1 2 3'), '应留存原表达');
  assert.match(issue.location, /^lines:\d+-\d+$/);
});

test('PAC/SQZ/DIF/DUP 混合编码与续行检查点', () => {
  const text = [
    '##TITLE=t',
    ...SPECTRAL_HEADER,
    '##XFACTOR=2',
    '##YFACTOR=0.5',
    '##FIRSTX=10',
    '##DELTAX=2',
    '##NPOINTS=6',
    '##XYDATA=(X++(Y..Y))',
    '10 B K S',
    '16 +4 J A',
    '##END='
  ].join('\n');
  const { blocks, issues } = parseJcamp(text);
  assert.deepEqual(issues, []);
  assert.deepEqual(blocks[0].points.map(point => [point.x, point.y]), [
    [10, 1], [12, 2], [14, 2], [16, 2], [18, 2.5], [20, 0.5]
  ]);
});

test('XYPOINTS 的 X 按来源 XFACTOR 缩放', () => {
  const text = [
    '##TITLE=t',
    ...SPECTRAL_HEADER,
    '##XFACTOR=2',
    '##YFACTOR=0.1',
    '##NPOINTS=2',
    '##XYPOINTS=(XY..XY)',
    '1,7 2,8',
    '##END='
  ].join('\n');
  const { blocks, issues } = parseJcamp(text);
  assert.deepEqual(issues, []);
  assert.deepEqual(blocks[0].points.map(point => [point.x, point.y]), [[2, 0.7], [4, 0.8]]);
});

test('独立光谱块没有 ##END= 也能解释，不算截断', () => {
  const text = [
    '##TITLE=only',
    ...SPECTRAL_HEADER,
    '##XFACTOR=1',
    '##YFACTOR=1',
    '##FIRSTX=0',
    '##DELTAX=1',
    '##NPOINTS=2',
    '##XYDATA=(X++(Y..Y))',
    '0 A J'
  ].join('\n');
  const { blocks, issues } = parseJcamp(text);
  assert.deepEqual(issues, []);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].points.map(point => point.y), [1, 2]);
});

test('未知标签原样留存，信封未知标签明确标识', () => {
  const text = [
    '##TITLE=env',
    '##JCAMP-DX=5.01',
    '##DATA TYPE=LINK',
    '##CUSTOM-ENVELOPE=x',
    '##TITLE=b',
    ...SPECTRAL_HEADER,
    '##ORIGIN=复测实验室',
    '##XFACTOR=1',
    '##YFACTOR=1',
    '##NPOINTS=1',
    '##XYPOINTS=(XY..XY)',
    '1,7',
    '##END=',
    '##END='
  ].join('\n');
  const { blocks, issues } = parseJcamp(text);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].value.unhandledLabels, [{ line: 10, text: '##ORIGIN=复测实验室' }]);
  const envelope = issues.find(issue => issue.reason === 'unhandled_label');
  assert.ok(envelope && envelope.detail.includes('##CUSTOM-ENVELOPE=x'), '信封未知标签应明确标识');
});

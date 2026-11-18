// JCAMP-DX 忠实读数解析器。
// 设计约束：
// - 每个块用自己的表头上下文（单位、因子、点数），上下文绝不跨块继承；
// - AFFN / SQZ / PAC / DIF / DIFDUP 数字表达，XYDATA 与 XYPOINTS 表格；
// - DIF 跨行状态延续，行首检查点只复核、不计入观测；
// - 遇到损坏或不支持的语法，保留原表达与影响范围，绝不猜值凑点；
// - 每个读数都携带原编码位置（行、列、字节区间），可回到原收件逐字复查。

const KNOWN_LABELS = new Set([
  'TITLE', 'JCAMP-DX', 'DATA TYPE', 'BLOCKS', 'XUNITS', 'YUNITS',
  'XFACTOR', 'YFACTOR', 'FIRSTX', 'LASTX', 'DELTAX', 'NPOINTS',
  'XYDATA', 'XYPOINTS', 'END'
]);
const DATA_LABELS = new Set(['XYDATA', 'XYPOINTS']);

// SQZ 字符：带符号的一位数字；@ 与 0 都表示零。
const SQZ_CHARS = new Map([
  ['@', 0],
  ...'0123456789'.split('').map(digit => [digit, Number(digit)]),
  ...'ABCDEFGHI'.split('').map((letter, index) => [letter, index + 1]),
  ...'abcdefghi'.split('').map((letter, index) => [letter, -(index + 1)])
]);
// DIF 在 SQZ 之外增加差分字符 J-R / j-r。
const DIF_CHARS = new Map([
  ...SQZ_CHARS,
  ...'JKLMNOPQR'.split('').map((letter, index) => [letter, index + 1]),
  ...'jklmnopqr'.split('').map((letter, index) => [letter, -(index + 1)])
]);
// DIFDUP 再增加重复次数字符 S-Z / s-z。
const DIFDUP_REPEAT = new Map([
  ...'STUVWXYZ'.split('').map((letter, index) => [letter, index + 1]),
  ...'stuvwxyz'.split('').map((letter, index) => [letter, -(index + 1)])
]);

function isRepeatChar(char) {
  return DIFDUP_REPEAT.has(char);
}

function splitLines(bytes) {
  const lines = [];
  let start = 0;
  const push = (lineStart, lineEnd) => {
    let sliceEnd = lineEnd;
    if (sliceEnd > lineStart && bytes[sliceEnd - 1] === 0x0d) sliceEnd -= 1;
    lines.push({
      number: lines.length + 1,
      startByte: lineStart,
      endByte: sliceEnd,
      text: bytes.subarray(lineStart, sliceEnd).toString('utf8')
    });
  };
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      push(start, index);
      start = index + 1;
    }
  }
  if (start < bytes.length) push(start, bytes.length);
  return lines;
}

// 列按 1 起计的码点（人工阅读位置），字节区间用于回到原收件逐字节复查。
function locationOf(line, column = 1, textLength = 0) {
  const before = Buffer.byteLength(line.text.slice(0, column - 1), 'utf8');
  const byteStart = line.startByte + before;
  // 直接从行原始字节按前缀长度切片，避免多字节字符把字符串下标和字节下标混淆。
  const sliceText = line.text.slice(column - 1, column - 1 + textLength);
  let byteLength = Buffer.byteLength(sliceText, 'utf8');
  if (byteLength === 0) byteLength = 1;
  return `line:${line.number};col:${column};byte:${byteStart}-${byteStart + byteLength}`;
}

function rangeLocation(firstLine, lastLine) {
  return `line:${firstLine.number}-${lastLine.number};byte:${firstLine.startByte}-${lastLine.endByte}`;
}

function tokenize(line) {
  const tokens = [];
  const regex = /\S+/g;
  let match;
  while ((match = regex.exec(line.text)) !== null) {
    tokens.push({
      text: match[0],
      line,
      column: match.index + 1,
      location: locationOf(line, match.index + 1, match[0].length)
    });
  }
  return tokens;
}

// 纯 AFFN 数字（含小数、科学计数、正负号）。
function affnNumber(token) {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

// SQZ 风格单记号解码：一个记号就是一个数，字母携带该位数值与符号。
// 与普通书写一致：前导 0/@ 不改变数值，字母位本身是有效数字。
function decodeSqzToken(token) {
  const integerDigits = [];
  const fractionDigits = [];
  let sign = 1;
  let fractional = false;
  let started = false;
  for (const char of token) {
    if (char === '.' || char === ',') {
      if (fractional) return null;
      fractional = true;
      continue;
    }
    if (char === '+') { sign = 1; continue; }
    if (char === '-') { sign = -1; continue; }
    const digit = SQZ_CHARS.get(char);
    if (digit === undefined) return null;
    started = true;
    if (digit < 0) sign = -1; // 小写字母标记负数
    (fractional ? fractionDigits : integerDigits).push(Math.abs(digit));
  }
  if (!started) return null;
  const integer = integerDigits.reduce((acc, digit) => acc * 10 + digit, 0);
  let fraction = 0;
  fractionDigits.forEach((digit, index) => { fraction += digit * 10 ** -(index + 1); });
  return sign * (integer + fraction);
}

// PAC 风格记号解码：一个记号可打包多个数，字母/@ 标记新数起点。
// 规则（JCAMP-DX PAC，小数点固定个位）：
//   - 字母/@ 开启一个新数并携带个位；其左侧连续的纯数字（如 5B 的 5）是该数更高位；
//   - 小数点后的数字属于最近确定的数，作为小数部分，不另起一数；
//   - 不在任何字母左侧、独立出现的整数本身是一个完整数。
function decodePacToken(token) {
  const numbers = [];
  let current = null;
  const start = (sign) => ({
    sign, ones: 0, higherDigits: [], leadingDigits: [], fractionDigits: [],
    fraction: false, hasOnes: false
  });
  const finish = () => {
    if (current === null) return;
    const higher = current.higherDigits; // 书写顺序：十位、百位、千位……
    const integer = higher.reduce((acc, digit, index) => acc + digit * 10 ** (higher.length - index), 0)
      + current.ones;
    let fraction = 0;
    current.fractionDigits.forEach((digit, index) => { fraction += digit * 10 ** -(index + 1); });
    numbers.push(current.sign * (integer + fraction));
    current = null;
  };
  for (const char of token) {
    if (char === '.' || char === ',') {
      if (current === null) current = start(1);
      if (current.fraction) return null; // 一个数至多一个小数点
      current.fraction = true;
      continue;
    }
    if (char === '+' || char === '-') {
      finish();
      current = start(char === '-' ? -1 : 1);
      continue;
    }
    const digit = SQZ_CHARS.get(char);
    if (digit === undefined) return null;
    if (current === null) current = start(1);
    const magnitude = Math.abs(digit);
    if (digit < 0) current.sign = -1;
    if (/[A-Ia-i@]/.test(char)) {
      // 字母/@ 携带个位；此前累积的前导数字成为更高位。
      if (current.hasOnes) finish();
      if (current === null) current = start(digit < 0 ? -1 : 1);
      current.higherDigits = current.leadingDigits.splice(0);
      current.ones = magnitude;
      current.hasOnes = true;
      continue;
    }
    if (current.fraction) current.fractionDigits.push(magnitude); // 小数点后：当前数的小数位
    else if (current.hasOnes) current.higherDigits.push(magnitude); // 个位已定：后续整数为更高位
    else current.leadingDigits.push(magnitude);
  }
  finish();
  return numbers.length ? numbers : null;
}

// DIF / DIFDUP 记号解码：返回差分实际数值（重复字符不在此处理）。
function decodeDifToken(token) {
  const affn = affnNumber(token);
  if (affn !== null) return affn;
  const integerDigits = [];
  const fractionDigits = [];
  let sign = 1;
  let fractional = false;
  let started = false;
  for (const char of token) {
    if (char === '.' || char === ',') {
      if (fractional) return null;
      fractional = true;
      continue;
    }
    if (char === '+') { sign = 1; continue; }
    if (char === '-') { sign = -1; continue; }
    const digit = DIF_CHARS.get(char);
    if (digit === undefined) return null;
    started = true;
    if (digit < 0) sign = -1; // 小写字母标记负数
    (fractional ? fractionDigits : integerDigits).push(Math.abs(digit));
  }
  if (!started) return null;
  const integer = integerDigits.reduce((acc, digit) => acc * 10 + digit, 0);
  let fraction = 0;
  fractionDigits.forEach((digit, index) => { fraction += digit * 10 ** -(index + 1); });
  return sign * (integer + fraction);
}

function detectCompression(text) {
  if (/[S-Zs-z]/.test(text)) return 'DIFDUP';
  if (/[J-Rj-r]/.test(text)) return 'DIF';
  if (/[A-Ia-i@]/.test(text)) return 'PACKED'; // SQZ 与 PAC 同走打包分支，按记号再区分
  return 'AFFN';
}

// 单个记号解码为若干 y 值：含小数点的字母记号是 PAC（可多值），否则是 SQZ/AFFN 单值。
function decodePackedToken(token) {
  const plain = affnNumber(token);
  if (plain !== null) return [plain];
  if (!/[.]/.test(token)) {
    const value = decodeSqzToken(token);
    return value === null ? null : [value];
  }
  return decodePacToken(token);
}

function scaled(value, factor) {
  if (factor === 1) return value;
  return Number.parseFloat((value * factor).toPrecision(12));
}

function buildScopes(lines, receiptId, issues) {
  const scopes = [];
  const stack = [];
  const top = () => stack.at(-1) || null;
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed === '' || trimmed.startsWith('$$')) continue;
    if (trimmed.startsWith('##')) {
      const match = trimmed.match(/^##([^=]*)=(.*)$/s);
      if (!match) {
        issues.push({
          receiptId, reason: 'malformed-label',
          location: locationOf(line), raw: line.text
        });
        continue;
      }
      if (match[1].trim() === '') {
        // 孤立的 ## 或 ##= 不是有效标签，原样留存后跳过。
        issues.push({
          receiptId, reason: 'malformed-label',
          location: locationOf(line), raw: line.text
        });
        continue;
      }
      const ldr = {
        rawLabel: match[1].trim(),
        label: match[1].trim().toUpperCase(),
        value: match[2].trim(),
        line, dataLines: []
      };
      if (ldr.label === 'TITLE' || stack.length === 0) {
        const scope = { titleLdr: ldr.label === 'TITLE' ? ldr : null, ldrs: [], closed: false, startLine: line };
        scopes.push(scope);
        stack.push(scope);
      }
      top().ldrs.push(ldr);
      if (ldr.label === 'END') {
        const scope = top();
        scope.closed = true;
        scope.endLine = line;
        if (ldr.value === '') {
          // ##END= 结束当前子块，回到外层未闭合作用域（如 LINK 信封）。
          stack.pop();
        } else {
          // ##END=title 形式：关闭当前文件的全部作用域。
          stack.length = 0;
        }
      }
    } else if (top()) {
      // 未带标签的行只可能属于当前块最近一个 LDR（通常是数据表标签）。
      const ldr = top().ldrs.at(-1);
      if (ldr) ldr.dataLines.push(line);
    }
  }
  for (const scope of scopes) {
    if (!scope.closed) {
      issues.push({
        receiptId, reason: 'unterminated-block',
        location: rangeLocation(scope.startLine, lines.at(-1) || scope.startLine),
        raw: scope.titleLdr ? scope.titleLdr.value : ''
      });
    }
  }
  return scopes;
}

function headerOf(scope, label) {
  const found = scope.ldrs.filter(ldr => ldr.label === label);
  return found.length ? found.at(-1) : undefined;
}

function numberHeader(scope, label, fallback, receiptId, issues) {
  const ldr = headerOf(scope, label);
  if (!ldr) return { value: fallback, location: null };
  const value = affnNumber(ldr.value);
  if (value === null) {
    issues.push({
      receiptId, reason: 'invalid-numeric-header',
      location: locationOf(ldr.line), raw: ldr.line.text
    });
    return { value: fallback, location: locationOf(ldr.line) };
  }
  return { value, location: locationOf(ldr.line) };
}

function decodeXydata(table, context, receiptId, issues) {
  const { title } = context;
  const points = [];
  if (!/X\+\+/i.test(table.value) || !/Y\.\.Y/i.test(table.value)) {
    issues.push({
      receiptId, block: title, reason: 'unsupported-table-syntax',
      location: rangeLocation(table.line, table.dataLines.at(-1) || table.line),
      raw: table.line.text + '\n' + table.dataLines.map(line => line.text).join('\n')
    });
    return { points, compression: 'UNSUPPORTED' };
  }
  const yText = table.dataLines.map(line => tokenize(line).slice(1).map(token => token.text).join(' ')).join(' ');
  const compression = detectCompression(yText);
  let running = null;
  let previousDifference = null;
  let firstLine = true;
  let stopped = false;

  const emit = (index, xRaw, yRaw, tokenLocation) => {
    points.push({
      index,
      x: scaled(xRaw, context.xFactor),
      y: scaled(yRaw, context.yFactor),
      xRaw, yRaw,
      location: tokenLocation
    });
  };

  for (const line of table.dataLines) {
    if (stopped) break;
    const tokens = tokenize(line);
    if (tokens.length === 0) continue;
    const xToken = tokens[0];
    const yTokens = tokens.slice(1);
    const anchorAffn = affnNumber(xToken.text);
    const anchorRaw = anchorAffn !== null ? anchorAffn : decodeSqzToken(xToken.text);
    if (anchorRaw === null) {
      issues.push({
        receiptId, block: title, reason: 'invalid-encoded-token',
        location: xToken.location, raw: xToken.text
      });
      stopped = true;
      break;
    }
    // 行首 X 是本行第一个读数的 x 锚点，不是第 N 个点的全局序号；
    // 用它复核网格，读数的 x 仍由 FIRSTX/DELTAX 统一定位，锚点不计入观测。
    const anchorIndex = points.length;
    const expectedAnchor = context.firstX + anchorIndex * context.deltaX;
    if (Math.abs(anchorRaw - expectedAnchor) > Math.max(1e-9, Math.abs(expectedAnchor) * 1e-9)) {
      issues.push({
        receiptId, block: title, reason: 'x-anchor-mismatch',
        location: xToken.location, raw: xToken.text,
        expected: expectedAnchor, received: anchorRaw
      });
    }

    if (compression === 'DIF' || compression === 'DIFDUP') {
      let cursor = 0;
      if (!firstLine) {
        const checkpoint = yTokens[cursor];
        if (!checkpoint) {
          issues.push({
            receiptId, block: title, reason: 'corrupted-subblock',
            location: locationOf(line), raw: line.text
          });
          stopped = true;
          break;
        }
        const checkpointAffn = affnNumber(checkpoint.text);
        const checkpointValue = checkpointAffn !== null ? checkpointAffn : decodeSqzToken(checkpoint.text);
        if (checkpointValue === null || checkpointValue !== running) {
          // 检查点对不上：差分状态已失去依据，保留原行与影响范围，停止本段后续读数。
          issues.push({
            receiptId, block: title, reason: 'dif-checkpoint-mismatch',
            location: rangeLocation(line, table.dataLines.at(-1)),
            raw: table.dataLines.slice(table.dataLines.indexOf(line)).map(item => item.text).join('\n'),
            expected: running, received: checkpointValue
          });
          stopped = true;
          break;
        }
        cursor += 1; // 检查点只复核，不是额外观测
      }
      while (cursor < yTokens.length) {
        const token = yTokens[cursor];
        if (compression === 'DIFDUP' && [...token.text].every(isRepeatChar)) {
          if (previousDifference === null) {
            issues.push({
              receiptId, block: title, reason: 'corrupted-subblock',
              location: token.location, raw: token.text
            });
            stopped = true;
            break;
          }
          for (const char of token.text) {
            const repeats = Math.abs(DIFDUP_REPEAT.get(char));
            for (let count = 0; count < repeats; count += 1) {
              running += previousDifference;
              emit(points.length, context.firstX + points.length * context.deltaX, running, token.location);
            }
          }
        } else if (firstLine && running === null) {
          // DIF 首行首个记号是 SQZ/AFFN 编码的实际值，后续记号才是差分。
          const affn = affnNumber(token.text);
          const initial = affn !== null ? affn : decodeSqzToken(token.text);
          if (initial === null || (compression === 'DIFDUP' && [...token.text].some(char => isRepeatChar(char)))) {
            issues.push({
              receiptId, block: title, reason: 'invalid-encoded-token',
              location: token.location, raw: token.text
            });
            stopped = true;
            break;
          }
          running = initial;
          emit(points.length, context.firstX + points.length * context.deltaX, running, token.location);
        } else {
          const difference = decodeDifToken(token.text);
          if (difference === null || (compression === 'DIFDUP' && [...token.text].some(char => isRepeatChar(char)))) {
            issues.push({
              receiptId, block: title, reason: 'invalid-encoded-token',
              location: token.location, raw: token.text
            });
            stopped = true;
            break;
          }
          running += difference;
          previousDifference = difference;
          emit(points.length, context.firstX + points.length * context.deltaX, running, token.location);
        }
        cursor += 1;
      }
    } else if (compression === 'PACKED') {
      for (const token of yTokens) {
        const numbers = decodePackedToken(token.text);
        if (numbers === null) {
          issues.push({
            receiptId, block: title, reason: 'invalid-encoded-token',
            location: token.location, raw: token.text
          });
          stopped = true;
          break;
        }
        for (const yRaw of numbers) {
          emit(points.length, context.firstX + points.length * context.deltaX, yRaw, token.location);
        }
      }
    } else {
      for (const token of yTokens) {
        const yRaw = affnNumber(token.text);
        if (yRaw === null) {
          issues.push({
            receiptId, block: title, reason: 'invalid-encoded-token',
            location: token.location, raw: token.text
          });
          stopped = true;
          break;
        }
        emit(points.length, context.firstX + points.length * context.deltaX, yRaw, token.location);
      }
    }
    firstLine = false;
  }
  return { points, compression, stopped };
}

function decodeXypoints(table, context, receiptId, issues) {
  const points = [];
  if (!/XY\.\.XY/i.test(table.value) && !/^\(XY/i.test(table.value)) {
    issues.push({
      receiptId, block: context.title, reason: 'unsupported-table-syntax',
      location: rangeLocation(table.line, table.dataLines.at(-1) || table.line),
      raw: table.line.text
    });
    return { points, compression: 'UNSUPPORTED' };
  }
  const flatText = table.dataLines.map(line => line.text).join(' ');
  const compression = detectCompression(flatText.replace(/,/g, ' '));
  if (compression === 'DIF' || compression === 'DIFDUP') {
    issues.push({
      receiptId, block: context.title, reason: 'unsupported-table-syntax',
      location: rangeLocation(table.line, table.dataLines.at(-1) || table.line),
      raw: table.dataLines.map(line => line.text).join('\n')
    });
    return { points, compression: 'UNSUPPORTED' };
  }
  let stopped = false;
  for (const line of table.dataLines) {
    if (stopped) break;
    const pieces = [];
    for (const token of tokenize(line)) {
      if (!token.text.includes(',')) {
        pieces.push({ text: token.text, location: token.location });
        continue;
      }
      // 逗号分隔的并列值：按片段重算列与字节位置，保证每个值可独立回查。
      let offset = 0;
      for (const part of token.text.split(',')) {
        if (part !== '') {
          pieces.push({ text: part, location: locationOf(line, token.column + offset, part.length) });
        }
        offset += part.length + 1;
      }
    }
    if (pieces.length % 2 !== 0) {
      issues.push({
        receiptId, block: context.title, reason: 'corrupted-subblock',
        location: locationOf(line), raw: line.text
      });
      stopped = true;
      break;
    }
    for (let index = 0; index < pieces.length; index += 2) {
      const [xPiece, yPiece] = [pieces[index], pieces[index + 1]];
      let xRaw = affnNumber(xPiece.text);
      let yRaw = affnNumber(yPiece.text);
      if (compression === 'PACKED') {
        if (xRaw === null) {
          const packed = decodePackedToken(xPiece.text);
          if (!packed || packed.length !== 1) {
            issues.push({ receiptId, block: context.title, reason: 'invalid-encoded-token', location: xPiece.location, raw: xPiece.text });
            stopped = true; break;
          }
          xRaw = packed[0];
        }
        if (yRaw === null) {
          const packed = decodePackedToken(yPiece.text);
          if (!packed || packed.length !== 1) {
            issues.push({ receiptId, block: context.title, reason: 'invalid-encoded-token', location: yPiece.location, raw: yPiece.text });
            stopped = true; break;
          }
          yRaw = packed[0];
        }
      }
      if (xRaw === null || yRaw === null) {
        issues.push({
          receiptId, block: context.title, reason: 'invalid-encoded-token',
          location: xRaw === null ? xPiece.location : yPiece.location,
          raw: (xRaw === null ? xPiece.text : yPiece.text)
        });
        stopped = true; break;
      }
      points.push({
        index: points.length,
        x: scaled(xRaw, context.xFactor),
        y: scaled(yRaw, context.yFactor),
        xRaw, yRaw,
        location: yPiece.location
      });
    }
  }
  return { points, compression, stopped };
}

function interpretBlock(scope, blockIndex, receiptId, issues) {
  const titleLdr = headerOf(scope, 'TITLE');
  const title = titleLdr ? titleLdr.value : `block-${blockIndex + 1}`;
  const dataTypeLdr = headerOf(scope, 'DATA TYPE');
  const unitsLdr = headerOf(scope, 'XUNITS');
  const yUnitsLdr = headerOf(scope, 'YUNITS');
  const xFactor = numberHeader(scope, 'XFACTOR', 1, receiptId, issues);
  const yFactor = numberHeader(scope, 'YFACTOR', 1, receiptId, issues);
  const firstX = numberHeader(scope, 'FIRSTX', 0, receiptId, issues);
  const lastXHeader = headerOf(scope, 'LASTX');
  const deltaX = numberHeader(scope, 'DELTAX', 1, receiptId, issues);
  const nPointsLdr = headerOf(scope, 'NPOINTS');
  const declaredPoints = nPointsLdr ? affnNumber(nPointsLdr.value) : null;
  if (nPointsLdr && declaredPoints === null) {
    issues.push({
      receiptId, block: title, reason: 'invalid-numeric-header',
      location: locationOf(nPointsLdr.line), raw: nPointsLdr.line.text
    });
  }
  const unknownLabels = scope.ldrs
    .filter(ldr => !KNOWN_LABELS.has(ldr.label))
    .map(ldr => ({ label: ldr.rawLabel, value: ldr.value, location: locationOf(ldr.line) }));

  const context = {
    blockIndex, title,
    xFactor: xFactor.value, yFactor: yFactor.value,
    firstX: firstX.value, deltaX: deltaX.value
  };
  const tables = scope.ldrs.filter(ldr => DATA_LABELS.has(ldr.label) || /TABLE/i.test(ldr.label));
  let points = [];
  let compression = 'NONE';
  let tableKind = null;
  for (const table of tables) {
    if (!DATA_LABELS.has(table.label)) {
      issues.push({
        receiptId, block: title, reason: 'unsupported-table-syntax',
        location: rangeLocation(table.line, table.dataLines.at(-1) || table.line),
        raw: [table.line.text, ...table.dataLines.map(line => line.text)].join('\n')
      });
      continue;
    }
    if (tableKind !== null) {
      issues.push({
        receiptId, block: title, reason: 'unsupported-table-syntax',
        location: rangeLocation(table.line, table.dataLines.at(-1) || table.line),
        raw: table.line.text
      });
      continue;
    }
    tableKind = table.label;
    const decoded = table.label === 'XYDATA'
      ? decodeXydata(table, context, receiptId, issues)
      : decodeXypoints(table, context, receiptId, issues);
    points = decoded.points;
    compression = decoded.compression;
  }

  if (declaredPoints !== null && declaredPoints !== points.length) {
    const table = tables[0];
    issues.push({
      receiptId, block: title, reason: 'point-count-mismatch',
      location: table
        ? rangeLocation(table.line, table.dataLines.at(-1) || table.line)
        : rangeLocation(scope.startLine, scope.endLine || scope.startLine),
      declaredPoints, receivedPoints: points.length
    });
  }
  if (lastXHeader && declaredPoints !== null) {
    const lastX = affnNumber(lastXHeader.value);
    const expected = firstX.value + (declaredPoints - 1) * deltaX.value;
    if (lastX !== null && Math.abs(lastX - expected) > Math.max(1e-9, Math.abs(expected) * 1e-9)) {
      issues.push({
        receiptId, block: title, reason: 'lastx-mismatch',
        location: locationOf(lastXHeader.line), raw: lastXHeader.line.text,
        expected, received: lastX
      });
    }
  }

  const provenance = [titleLdr, nPointsLdr, unitsLdr, yUnitsLdr, headerOf(scope, 'XFACTOR'), headerOf(scope, 'YFACTOR'), tables[0]]
    .filter(ldr => ldr)
    .map(ldr => ({ receiptId, location: locationOf(ldr.line) }));

  return {
    block: {
      key: `spectrum-block:${receiptId}:${blockIndex}`,
      value: {
        title,
        declaredPoints,
        receivedPoints: points.length,
        xUnits: unitsLdr ? unitsLdr.value : null,
        yUnits: yUnitsLdr ? yUnitsLdr.value : null,
        dataType: dataTypeLdr ? dataTypeLdr.value : null,
        table: tableKind,
        compression,
        xFactor: xFactor.value,
        yFactor: yFactor.value,
        firstX: firstX.value,
        lastX: lastXHeader ? affnNumber(lastXHeader.value) : null,
        deltaX: deltaX.value,
        unknownLabels
      },
      provenance
    },
    points: points.map(point => ({
      key: `spectral-point:${receiptId}:${blockIndex}:${point.index}`,
      value: { block: title, index: point.index, x: point.x, y: point.y },
      provenance: [{ receiptId, location: point.location }]
    }))
  };
}

// 入口：bytes 为原收件 Buffer，receiptId 用于把每条出处绑回真实收件。
export function parseJcamp(bytes, receiptId) {
  const issues = [];
  const lines = splitLines(Buffer.from(bytes));
  const scopes = buildScopes(lines, receiptId, issues);
  const linkScope = scopes.find(scope =>
    scope.ldrs.some(ldr => ldr.label === 'DATA TYPE' && ldr.value.toUpperCase() === 'LINK'));
  const envelopeLink = Boolean(linkScope);
  const blockScopes = envelopeLink ? scopes.filter(scope => scope !== linkScope) : scopes;

  if (envelopeLink) {
    const blocksLdr = headerOf(linkScope, 'BLOCKS');
    if (blocksLdr) {
      const declared = affnNumber(blocksLdr.value);
      if (declared !== null && declared !== blockScopes.length) {
        issues.push({
          receiptId, reason: 'block-count-mismatch',
          location: locationOf(blocksLdr.line),
          declaredBlocks: declared, receivedBlocks: blockScopes.length
        });
      }
    }
  }

  const records = [];
  blockScopes.forEach((scope, blockIndex) => {
    const interpreted = interpretBlock(scope, blockIndex, receiptId, issues);
    records.push({ kind: 'spectrum-block', ...interpreted.block });
    records.push(...interpreted.points.map(point => ({ kind: 'spectral-point', ...point })));
  });
  return { records, issues, blockCount: blockScopes.length, link: envelopeLink };
}

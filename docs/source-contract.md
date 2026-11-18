# 来源资料契约

支持 LINK 与独立光谱块、AFFN/PAC/SQZ/DIF/DUP 数字表达、XYDATA 和 XYPOINTS。差分跨行检查点按 JCAMP 规则复核，不重复计入观测。spectrum-block 含 title、declaredPoints、receivedPoints、xUnits、yUnits，并保留 table、compression、xFactor、yFactor、firstX、lastX、deltaX 与 unknownLabels；spectral-point 含 block、index（0起）、x、y 和原编码位置。数字缩放只按来源 XFACTOR/YFACTOR（xFactor/yFactor 字段即缩放依据），不做峰判断。未知标签原样留存，不支持的表格语法要报范围；partial 文件去掉尾段且点数不闭合。

出处 location 采用 `line:<行>;col:<列>;byte:<起>-<止>`（表头与读数）或 `line:<起>-<止>;byte:<起>-<止>`（子块/范围），列按码点、字节区间按 UTF-8 原字节，可回到原收件逐字复查；range 类问题用行区间表达影响范围。损坏或不支持情形（dif-checkpoint-mismatch、corrupted-subblock、invalid-encoded-token、unsupported-table-syntax、point-count-mismatch、unterminated-block、block-count-mismatch 等）在 issues 中给出 reason、location，并在 raw 中保留原表达；已核实的读数照常保留，缺失部分不猜值凑点。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

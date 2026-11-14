# 来源资料契约

支持 LINK 与独立光谱块、AFFN/PAC/SQZ/DIF/DUP 数字表达、XYDATA 和 XYPOINTS。差分跨行检查点按 JCAMP 规则复核，不重复计入观测。spectrum-block 含 title、declaredPoints、receivedPoints、xUnits、yUnits；spectral-point 含 block、index（0起）、x、y 和原编码位置。数字缩放只按来源 XFACTOR/YFACTOR，不做峰判断。未知标签原样留存，不支持的表格语法要报范围；partial 文件去掉尾段且点数不闭合。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

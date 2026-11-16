# 来源资料契约

支持 version=3 的普通和 indexed source map，sections 可以内联 map 或外置 url。sourceRoot 相对含该值的 map URL 解释，内联 map 继承其外层地址。输出行号从 1 开始、列从 0 开始。mapped-position 的 value 包含 generatedLine、generatedColumn、sourcePath、originalLine、originalColumn；unmapped-range 保留无源区间。源码不存在时保留映射，记录 source-unavailable，不能伪造 sourcesContent。所有获取限制同一授权 origin。来源可在 partial 模式缺少外置分段。

每段的位置以该段自己的地址为基准合成：段 offset 的行偏移作用于该段所有行，列偏移只作用于该段的首行；嵌套 sections 逐层合成。未映射区间只保留自己的起点，不继承上一个已映射段的源码位置，也不推测压缩脚本长度。某段缺件时，该段标记 missing 并写入 issue，其余段继续解释，整体 explanation.state 为 partial。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。自动解释的 records 带 automatic 标记；不同 map 或不同版本中同名文件按各自收件记录，不互相覆盖。

unmapped-range 的起点也用 generatedLine 与 generatedColumn 表示；原分段不包含的末端长度可以保持未知，不推测压缩脚本长度。

/src/b.ts 由 b.ts.raw 提供原始交付字节；它是被归档的外部源码资料，不是收件服务的可执行模块。

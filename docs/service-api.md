# 收件服务接口

人工资料接收保持兼容。POST /intakes 的 JSON 字段为 collectionId、sourceKey、revision、mediaType、contentBase64；返回 receiptId、sha256、byteLength 和轻量 summary。相同资料集、来源键与修订对应同一收件，字节不同返回 409。GET /receipts/{receiptId} 可读元数据，GET /receipts/{receiptId}/body 返回原字节。

POST /acquisitions 接受 collectionId、entry 和可选 options，entry 是授权来源完整地址。来源为交付索引时，服务读取 roots 指向的每个 source map，按需领取外置分段与源文件，并为每份自动取得的原文登记收件；每个入口 map、外置分段和外部源文件都有独立收件，内联 map 与外层共享同一收件。返回 collectionId、receiptIds、records、issues 和 explanation。自动解释沿用此入口，所有自动取得的依赖也保留真实原文收件，不用人工造 records 代替自动接入。来源访问只限启动时冻结的 origin，不能访问其他主机或执行交付件。

explanation 说明本次解释的可信范围，而不是一个笼统的成功标记：

- state 为 explained 或 partial；complete 只有在所有 map 与分段都得到解释、且没有未解决 issue 时才为 true。
- maps 列出每个 map 载荷（含内联 map 与外置 map），带 url、receiptId、location、kind、state 以及该 map 的 section 偏移出处。内联 map 继承外层地址，外置 map 以自己的 URL 作为 sourceRoot 与相对源地址的基准。
- sections 汇总分段数：total、explained、missing、invalid，items 逐段给出 offset、baseUrl、内联或外置来源以及该段自己的 state。缺一个外置分段时该段为 missing，并把 reason=section-unavailable 与位置写入 issues，其他段仍照常解释。
- mappedPositions、unmappedRanges、sources（embedded/external/unavailable 计数）给出实际解释量。收件成功不等于整份脚本都有可靠映射。
- acquisitions 按入口分别保留上述摘要。同一资料集先后领取多个入口时，任一入口不完整，资料集整体即为 partial；后一次成功不会掩盖先前的缺口。

GET /collections/{collectionId}/positions?line=&column= 用已归档记录解释一个生成位置（行从 1 开始、列从 0 开始）。返回 state=mapped 时给出 sourcePath、originalLine、originalColumn 与该位置所属分段的地址基准；state=unmapped 时返回该未映射区间的起点；state=unknown 表示该行没有可依据的分段起点；state=ambiguous 表示多份已归档映射对该起点给出不同结论。未映射区间不会沿用上一个源码位置，分段起始列偏移只施加在该段首行，跨行不继承。

GET /collections 返回资料集列表，GET /collections/{collectionId} 返回 collectionId、receiptIds、records、issues、explanation。结构化 records 的每项包含 kind、key、value、provenance；key 由各来源身份语义决定，不要求特定内部编码。provenance 是含 receiptId 与 location 的数组，location 可采用字节区间、原行列、JSON Pointer 等可复查定位。issues 每项包含 reason、location，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。缺失资料不等于来源明确删除。

自动记录使用以下 kind：

- mapped-position：value 含 generatedLine、generatedColumn、sourcePath、sourceUrl、originalLine、originalColumn 与 section（该段自己的 baseUrl、是否内联、原始 offset 和合成后 offset）。
- unmapped-range：value 含该区间起点的 generatedLine、generatedColumn 与 section；末端长度保持未知。
- source-content：value.sourceKind 区分 embedded（正文来自 map 的 sourcesContent）、external（正文另取并登记为独立收件，value.receiptId 指向它）与 unavailable（源文件暂缺，只保留路径与出处，不伪造正文）。

自动记录的 key 含 map 的收件标识与位置，因此同一交付重复领取幂等，另一版本的同名文件则新增自己的记录，不覆盖已归档原文。

POST /collections/{collectionId}/records 可录入人工确认记录，必须附本资料集的真实收件出处。自动接入不能依赖操作者事先写入答案。该接口目前采用同键不可变约定；新增版本、历史记录与当前视图如何协调，应与来源语义相符，不能覆盖已归档原文。来源契约中的值是查询视图契约，不限定解析器、状态机或索引的内部实现。自动记录带 automatic=true，人工记录不带该字段，二者按 key 区分，互不覆盖。

本地 provider 是独立 HTTP 来源，fixtures 为合成的公开样本，不包含真实个人或机构凭据。fixtures/descriptor.json 说明来源入口与接入选项。多数资料源用 /deliveries 声明 deliveryId、revision、roots 和 resources；roots 是需处理的独立入口，resources 是同包可领取资源，不是公网搜索指令。文件可用 GET、HEAD 与单段 Range 读取；ETag 表示返回字节的身份。SOURCE_STAGE=partial 启动不完整交付状态，完整状态是默认值。来源服务不接受写操作。

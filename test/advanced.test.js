const OT = require('../ot');
const DocumentManager = require('../documentManager');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`    Expected: ${JSON.stringify(expected)}`);
    console.log(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('=== 需求1: 到达顺序不影响最终结果 ===\n');

console.log('1. ABCDEF 例子：删除 BCDE(1,4) + 在D前(3)插入X, 两种到达顺序');
{
  function run(order) {
    const dm = new DocumentManager();
    dm.addClient('doc-abc', 'c1', 'ABCDEF');
    const results = {};
    if (order === 'delete-first') {
      results.del = dm.submitOperation('doc-abc', 'c-del', OT.createDelete(1, 4), 0, '001-delete');
      results.ins = dm.submitOperation('doc-abc', 'c-ins', OT.createInsert(3, 'X'), 0, '002-insert');
    } else {
      results.ins = dm.submitOperation('doc-abc', 'c-ins', OT.createInsert(3, 'X'), 0, '002-insert');
      results.del = dm.submitOperation('doc-abc', 'c-del', OT.createDelete(1, 4), 0, '001-delete');
    }
    return { ...dm.getDocumentState('doc-abc'), results };
  }

  const r1 = run('delete-first');
  const r2 = run('insert-first');

  console.log(`    删先到: 内容="${r1.content}", 版本=v${r1.version}`);
  console.log(`    插先到: 内容="${r2.content}", 版本=v${r2.version}`);

  assertEqual(r1.content, r2.content, '两种到达顺序的内容完全一致');
  assertEqual(r1.version, r2.version, '两种到达顺序的版本号一致');
  assert(r1.content.includes('X'), '插入的X在最终文档中存在');
  assert(r1.content.includes('A') && r1.content.includes('F'), 'A和F两端保留');
}

console.log('\n2. 同样的操作，不同ID排序，结果由ID升序决定');
{
  function runWithIds(deleteId, insertId) {
    const dm = new DocumentManager();
    dm.addClient('doc-sort', 'x', 'ABCDEF');
    dm.submitOperation('doc-sort', 'a', OT.createDelete(1, 4), 0, deleteId);
    dm.submitOperation('doc-sort', 'b', OT.createInsert(3, 'X'), 0, insertId);
    return dm.getDocumentState('doc-sort');
  }

  const deleteFirst = runWithIds('aaa-delete', 'zzz-insert');
  const insertFirst = runWithIds('zzz-delete', 'aaa-insert');

  console.log(`    ID:delete<insert → 内容="${deleteFirst.content}" (删除先处理)`);
  console.log(`    ID:insert<delete → 内容="${insertFirst.content}" (插入先处理)`);

  assertEqual(deleteFirst.content, 'AXF', '删除先处理，插入存活，被推到边界 → AXF');
  assertEqual(insertFirst.content, 'AEF', '插入先处理，删除范围包含插入位置，插入的X被删 → AEF');

  const runA = runWithIds('aaa', 'bbb');
  const runB = runWithIds('aaa', 'bbb');
  assertEqual(runA.content, runB.content, '相同ID集合重复运行结果一致');
}

console.log('\n=== 需求2: ACK和广播使用统一固定规则 ===\n');

console.log('3. overlapInfo 语义规则验证');
{
  const dm = new DocumentManager();
  dm.addClient('doc-overlap', 'c1', 'ABCDEF');
  const delResult = dm.submitOperation('doc-overlap', 'c-del', OT.createDelete(1, 4), 0, 'a-del');
  const insResult = dm.submitOperation('doc-overlap', 'c-ins', OT.createInsert(3, 'X'), 0, 'b-ins');

  assert(insResult.overlapInfo.length >= 1, '重叠操作返回overlapInfo');
  assertEqual(insResult.overlapInfo[0].type, 'insert_preserved_at_boundary', '类型是insert_preserved_at_boundary');
  assertEqual(insResult.overlapInfo[0].preserved, true, '插入被标记为preserved');
  assertEqual(insResult.overlapInfo[0].boundary, 'start', '被推到删除起始边界');
  assertEqual(insResult.overlapInfo[0].originalInsertPosition, 3, '原始位置正确记录');
  assertEqual(insResult.overlapInfo[0].newPosition, insResult.transformedOp.position, 'newPosition等于转换后的position');

  console.log(`    规则: 插入在删除范围内 → 保留，推到删除${insResult.overlapInfo[0].boundary}边界`);
  console.log(`    原始位置: ${insResult.overlapInfo[0].originalInsertPosition} → 最终位置: ${insResult.overlapInfo[0].newPosition}`);
}

console.log('\n4. transformedOp 与 originalOp 的对应关系（让离线客户端对齐）');
{
  const dm = new DocumentManager();
  dm.addClient('doc-align', 'base', 'Hello World');
  dm.submitOperation('doc-align', 'other', OT.createInsert(6, 'Beautiful '), 0, 'op-001');

  const offlineResult = dm.submitOperation(
    'doc-align', 'offline',
    OT.createInsert(6, 'Amazing '), 0, 'op-002'
  );

  assert(offlineResult.applied, '离线补交操作成功应用');
  assertEqual(offlineResult.baseVersion, 0, 'baseVersion记录正确');
  assertEqual(offlineResult.originalOp.position, 6, 'originalOp保持客户端提交的原位置');
  assert(offlineResult.transformedOp.position >= 6, 'transformedOp位置被后移（因为有并发插入）');
  assertEqual(offlineResult.originalOp.chars, offlineResult.transformedOp.chars, '插入字符内容不变');
  assertEqual(offlineResult.newVersion, 2, 'newVersion正确');

  console.log(`    客户端原提交: insert(6, "${offlineResult.originalOp.chars}")`);
  console.log(`    服务端转换后: insert(${offlineResult.transformedOp.position}, "${offlineResult.transformedOp.chars}")`);
  console.log(`    版本: v${offlineResult.baseVersion} → v${offlineResult.newVersion}`);
  const finalContent = dm.getDocumentState('doc-align').content;
  console.log(`    最终内容: "${finalContent}"`);
  assert(finalContent.includes('Beautiful') && finalContent.includes('Amazing'), '两次插入都存在');
}

console.log('\n=== 需求3: 真实协作场景测试 ===\n');

console.log('5. 连续插-删-插 + 旧版本补交');
{
  const dm = new DocumentManager();
  dm.addClient('doc-real', 'base-client', '');

  const steps = [];

  steps.push(dm.submitOperation('doc-real', 'A',
    OT.createInsert(0, '今天天气不错适合写代码'), 0, 'step-001'));
  const state1 = dm.getDocumentState('doc-real');
  console.log(`    v1: "${state1.content}"`);

  steps.push(dm.submitOperation('doc-real', 'B',
    OT.createInsert(8, '，'), 1, 'step-002'));
  const state2 = dm.getDocumentState('doc-real');
  console.log(`    v2: "${state2.content}"`);

  steps.push(dm.submitOperation('doc-real', 'C',
    OT.createDelete(0, 4), 2, 'step-003'));
  const state3 = dm.getDocumentState('doc-real');
  console.log(`    v3 删除"今天天气": "${state3.content}"`);

  steps.push(dm.submitOperation('doc-real', 'D',
    OT.createInsert(4, '出去散步也'), 3, 'step-004'));
  const state4 = dm.getDocumentState('doc-real');
  console.log(`    v4: "${state4.content}"`);

  assertEqual(state4.version, 4, '4步后版本号为4');
  assertEqual(state4.content, '不错适合出去散步也，写代码', 'v4内容正确');

  const offlineClientResult = dm.submitOperation(
    'doc-real', 'offline',
    OT.createInsert(4, '真的'), 1, 'step-offline'
  );

  const finalState = dm.getDocumentState('doc-real');
  console.log(``);
  console.log(`    离线客户端基于v1, 在位置4插入"真的"`);
  console.log(`    补交后最终v${finalState.version}: "${finalState.content}"`);

  assert(offlineClientResult.applied, '离线补交成功应用');
  assertEqual(offlineClientResult.baseVersion, 1, '客户端基于v1提交');
  assert(finalState.content.includes('真的'), '离线插入的内容在最终文档中');
  assertEqual(finalState.version, 5, '最终版本递增');

  console.log(``);
  console.log(`    完整性验证：`);
  console.log(`      - originalOp.position = ${offlineClientResult.originalOp.position}`);
  console.log(`      - transformedOp.position = ${offlineClientResult.transformedOp.position}`);
  console.log(`      - final content includes insertion: ${finalState.content.includes('真的')}`);

  const syncV1 = dm.getSyncData('doc-real', 1);
  let simulated = syncV1.baseContent;
  for (const op of syncV1.operations) {
    simulated = OT.apply(simulated, op);
  }
  assertEqual(simulated, finalState.content,
    'v1快照 + 增量操作 = 最终内容（完全对齐）');

  const syncResult = dm.getSyncData('doc-real', 1);
  assertEqual(syncResult.type, 'incremental', '同步类型incremental');
  assertEqual(syncResult.operations.length, 4, '返回4个增量操作');
  assertEqual(syncResult.content, finalState.content, '同步接口也返回完整快照');
  assertEqual(syncResult.baseContent, state1.content, 'baseContent匹配v1快照');
}

console.log('\n6. 版本一致性：所有返回结果互相印证');
{
  const dm = new DocumentManager();
  dm.addClient('doc-consist', 'c', 'The quick brown fox');

  const r1 = dm.submitOperation('doc-consist', 'a',
    OT.createInsert(16, ' jumps'), 0, 'op-A');
  const r2 = dm.submitOperation('doc-consist', 'b',
    OT.createDelete(0, 4), 1, 'op-B');
  const r3 = dm.submitOperation('doc-consist', 'c',
    OT.createInsert(15, ' lazy dog'), 2, 'op-C');
  const r4 = dm.submitOperation('doc-consist', 'd',
    OT.createInsert(0, 'Yesterday: '), 0, 'op-D-old');

  const finalState = dm.getDocumentState('doc-consist');

  console.log(`    最终内容: "${finalState.content}"`);
  console.log(`    最终版本: v${finalState.version}`);

  assertEqual(finalState.version, 4, '版本号一致');

  const historyOps = dm.getOperationsSince('doc-consist', 0);
  const initSnap = dm.getSyncData('doc-consist', 0).baseContent;
  let rebuilt = initSnap;
  for (const op of historyOps) {
    rebuilt = OT.apply(rebuilt, op);
  }
  assertEqual(rebuilt, finalState.content,
    'v0快照 + 全部历史操作 = 最终内容');
  assertEqual(historyOps.length, finalState.version,
    '历史操作数=版本号');

  const syncAll = dm.getSyncData('doc-consist', 0);
  assertEqual(syncAll.content, finalState.content,
    '同步接口返回的完整content=最终内容');
  assertEqual(syncAll.version, finalState.version,
    '同步接口返回的version=最终版本');

  const syncFrom2 = dm.getSyncData('doc-consist', 2);
  const snapV2 = syncFrom2.baseContent;
  let rebuiltFrom2 = snapV2;
  for (const op of syncFrom2.operations) {
    rebuiltFrom2 = OT.apply(rebuiltFrom2, op);
  }
  assertEqual(rebuiltFrom2, finalState.content,
    '从v2同步 + 增量重放 = 最终内容');
  console.log(`    从v2开始同步:${syncFrom2.type}, ${syncFrom2.operations.length}个操作`);
  console.log(`    v2 baseContent: "${snapV2}"`);
  console.log(`    sync.content(最新): "${syncFrom2.content}"`);
}

console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}

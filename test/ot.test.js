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

console.log('=== OT Algorithm Tests ===\n');

console.log('1. Insert operation application:');
{
  const doc = 'Hello World';
  const op = OT.createInsert(5, ' Beautiful');
  const result = OT.apply(doc, op);
  assertEqual(result, 'Hello Beautiful World', 'Insert at position 5');
}

console.log('\n2. Delete operation application:');
{
  const doc = 'Hello Beautiful World';
  const op = OT.createDelete(5, 10);
  const result = OT.apply(doc, op);
  assertEqual(result, 'Hello World', 'Delete 10 chars at position 5');
}

console.log('\n3. Concurrent inserts at different positions (insert-insert transform):');
{
  const doc = 'ABC';
  const op1 = OT.createInsert(1, 'x', 'a1');
  const op2 = OT.createInsert(2, 'y', 'b1');

  const [op1Prime, op2Prime] = OT.transform(op1, op2);

  const result1 = OT.apply(OT.apply(doc, op1), op2Prime);
  const result2 = OT.apply(OT.apply(doc, op2), op1Prime);

  assertEqual(result1, result2, 'Both paths converge to same result');
  assertEqual(result1, 'AxB yC'.replace(' ', ''), 'Correct content: AxByC');
}

console.log('\n4. Concurrent inserts at same position (tie-breaking by id):');
{
  const doc = 'ABC';
  const op1 = OT.createInsert(1, 'x', 'client-a');
  const op2 = OT.createInsert(1, 'y', 'client-b');

  const [op1Prime, op2Prime] = OT.transform(op1, op2);

  const result1 = OT.apply(OT.apply(doc, op1), op2Prime);
  const result2 = OT.apply(OT.apply(doc, op2), op1Prime);

  assertEqual(result1, result2, 'Both paths converge to same result');
  console.log(`    Converged result: "${result1}"`);
  assert(result1.length === 5, 'Result has 5 characters');
}

console.log('\n5. Insert then Delete transform:');
{
  const doc = 'Hello World';
  const insertOp = OT.createInsert(6, 'Beautiful ', 'a');
  const deleteOp = OT.createDelete(0, 5, 'b');

  const [newInsert, newDelete] = OT.transform(insertOp, deleteOp);

  const path1 = OT.apply(OT.apply(doc, insertOp), newDelete);
  const path2 = OT.apply(OT.apply(doc, deleteOp), newInsert);

  assertEqual(path1, path2, 'Both paths converge');
}

console.log('\n6. Delete-Delete (no overlap):');
{
  const doc = 'ABCDEFG';
  const op1 = OT.createDelete(0, 2, 'a');
  const op2 = OT.createDelete(4, 2, 'b');

  const [op1Prime, op2Prime] = OT.transform(op1, op2);

  const result1 = OT.apply(OT.apply(doc, op1), op2Prime);
  const result2 = OT.apply(OT.apply(doc, op2), op1Prime);

  assertEqual(result1, result2, 'Both paths converge');
  assertEqual(result1, 'CDG', 'Correctly deletes AB and EF, CD remains');
}

console.log('\n7. Delete-Delete (full overlap):');
{
  const doc = 'ABCDE';
  const op1 = OT.createDelete(1, 3, 'a');
  const op2 = OT.createDelete(1, 3, 'b');

  const [op1Prime, op2Prime] = OT.transform(op1, op2);

  const result1 = OT.apply(OT.apply(doc, op1), op2Prime);
  const result2 = OT.apply(OT.apply(doc, op2), op1Prime);

  assertEqual(result1, result2, 'Both paths converge');
  assertEqual(result1, 'AE', 'Same chars deleted, only one delete effective');
}

console.log('\n8. Transform against history (multiple ops):');
{
  const doc = 'ABC';
  const history = [
    OT.createInsert(1, 'x', 'h1'),
    OT.createInsert(3, 'y', 'h2')
  ];

  const myOp = OT.createInsert(2, 'z', 'me');
  const transformed = OT.transformAgainstHistory(myOp, history);

  const result = OT.apply(OT.apply(OT.apply(doc, history[0]), history[1]), transformed);
  assert(result.includes('z'), 'Transformed insert still present');
  console.log(`    Result: "${result}"`);
}

console.log('\n=== Document Manager Tests ===\n');

console.log('9. Document creation and state:');
{
  const dm = new DocumentManager();
  const state = dm.addClient('doc1', 'client1');
  assertEqual(state.version, 0, 'Initial version is 0');
  assertEqual(state.content, '', 'Initial content is empty');
}

console.log('\n10. Submit operation and version increment:');
{
  const dm = new DocumentManager();
  dm.addClient('doc1', 'client1');
  const result = dm.submitOperation('doc1', 'client1', OT.createInsert(0, 'Hello'), 0);
  assert(result.applied, 'Operation applied');
  assertEqual(result.newVersion, 1, 'Version incremented to 1');

  const state = dm.getDocumentState('doc1');
  assertEqual(state.content, 'Hello', 'Content updated');
  assertEqual(state.version, 1, 'State version matches');
}

console.log('\n11. Concurrent operations simulation:');
{
  const dm = new DocumentManager();
  dm.addClient('doc1', 'client1');
  dm.submitOperation('doc1', 'client1', OT.createInsert(0, 'ABC'), 0);

  const client1Op = OT.createInsert(3, 'X');
  const client2Op = OT.createInsert(3, 'Y');

  const result1 = dm.submitOperation('doc1', 'client1', client1Op, 1);
  assert(result1.applied, 'Client1 op applied');

  dm.addClient('doc1', 'client2');
  const result2 = dm.submitOperation('doc1', 'client2', client2Op, 1);
  assert(result2.applied, 'Client2 op applied (with transform)');

  const state = dm.getDocumentState('doc1');
  console.log(`    Final content: "${state.content}"`);
  assert(state.content.includes('X') && state.content.includes('Y'), 'Both inserts present');
  assertEqual(state.version, 3, 'Final version is 3');
}

console.log('\n12. Operations since version:');
{
  const dm = new DocumentManager();
  dm.addClient('doc1', 'client1');
  dm.submitOperation('doc1', 'client1', OT.createInsert(0, 'A'), 0);
  dm.submitOperation('doc1', 'client1', OT.createInsert(1, 'B'), 1);
  dm.submitOperation('doc1', 'client1', OT.createInsert(2, 'C'), 2);

  const ops = dm.getOperationsSince('doc1', 1);
  assertEqual(ops.length, 2, 'Returns 2 operations since v1');
}

console.log('\n13. Client presence management:');
{
  const dm = new DocumentManager();
  dm.addClient('doc1', 'client1');
  assertEqual(dm.getClientCount('doc1'), 1, '1 client after first join');

  dm.addClient('doc1', 'client2');
  assertEqual(dm.getClientCount('doc1'), 2, '2 clients after second join');

  dm.removeClient('doc1', 'client1');
  assertEqual(dm.getClientCount('doc1'), 1, '1 client after leave');
}

console.log('\n=== New Feature Tests ===\n');

console.log('14. Initial content only applies on first join (Req 1):');
{
  const dm = new DocumentManager();
  const state1 = dm.addClient('doc-new', 'client1', 'Hello World');
  assert(state1.created, 'First client creates document');
  assertEqual(state1.content, 'Hello World', 'First client content matches initial');

  const state2 = dm.addClient('doc-new', 'client2', 'Different Content');
  assert(!state2.created, 'Second client does not create document');
  assertEqual(state2.content, 'Hello World', 'Second client sees first client content, not overridden');

  dm.submitOperation('doc-new', 'client1', OT.createInsert(5, ' Beautiful'), state2.version);

  const state3 = dm.addClient('doc-new', 'client3', 'Totally different');
  assertEqual(state3.content, 'Hello Beautiful World', 'Third client sees latest edited content');
}

console.log('\n15. Insert inside delete range does not throw (Req 2):');
{
  const doc = 'ABCDEF';
  const deleteOp = OT.createDelete(1, 4, 'del1');
  const insertOp = OT.createInsert(3, 'x', 'ins1');

  let error = null;
  let result = null;
  try {
    result = OT.transform(insertOp, deleteOp);
  } catch (e) {
    error = e;
  }
  assert(!error, 'Transform does not throw error');
  assert(result !== null, 'Transform returns result');

  const [newInsert, newDelete] = result;
  assertEqual(newInsert.position, 1, 'Insert moves to delete start position');

  const path1 = OT.apply(OT.apply(doc, deleteOp), newInsert);
  console.log(`    Path (delete then insert): "${path1}"`);
  assert(path1.includes('x'), 'Inserted char still present in final doc');
}

console.log('\n16. All clients converge with insert-delete overlap (Req 2):');
{
  const dm = new DocumentManager();
  dm.addClient('doc-overlap', 'client1', 'ABCDEF');

  dm.submitOperation('doc-overlap', 'client1', OT.createDelete(1, 4), 0);

  dm.addClient('doc-overlap', 'client2', 'ABCDEF');
  const result = dm.submitOperation('doc-overlap', 'client2', OT.createInsert(3, 'X'), 0);

  assert(result.applied, 'Insert inside deleted range is applied');
  assertEqual(result.transformedOp.position, 1, 'Insert position transformed to delete start');

  const state = dm.getDocumentState('doc-overlap');
  console.log(`    Final content: "${state.content}"`);
  assert(state.content.includes('X'), 'Inserted char survives in final doc');
  assert(state.content.includes('A') && state.content.includes('F'), 'A and F still present');
}

console.log('\n17. ACK includes transformed operation details (Req 3):');
{
  const dm = new DocumentManager();
  dm.addClient('doc-ack', 'client1', 'ABC');

  dm.submitOperation('doc-ack', 'client1', OT.createInsert(1, 'x'), 0);

  const result = dm.submitOperation('doc-ack', 'client2', OT.createInsert(1, 'y'), 0);

  assert(result.applied, 'Operation applied');
  assert(result.transformedOp, 'Transformed op present in result');
  assert(result.transformedOp.position !== undefined, 'Transformed position available');
  assert(result.transformedOp.type === 'insert', 'Transformed op type preserved');
  assertEqual(result.transformedOp.chars, 'y', 'Transformed op chars preserved');
  assert(result.newVersion > 0, 'Version incremented');

  console.log(`    Original position: 1, Transformed position: ${result.transformedOp.position}`);
  assert(result.transformedOp.position === 2, 'Position shifted after prior insert');
}

console.log('\n18. Sync returns full snapshot + operations (Req 4):');
{
  const dm = new DocumentManager();
  dm.addClient('doc-sync', 'client1', '');

  for (let i = 0; i < 5; i++) {
    dm.submitOperation('doc-sync', 'client1', OT.createInsert(i, String.fromCharCode(65 + i)), i);
  }

  const syncData = dm.getSyncData('doc-sync', 2);
  assertEqual(syncData.type, 'incremental', 'Sync type is incremental when history available');
  assertEqual(syncData.version, 5, 'Returns latest version');
  assertEqual(syncData.baseVersion, 2, 'Base version matches request');
  assertEqual(syncData.operations.length, 3, 'Returns 3 missing operations');
  assert(syncData.content, 'Returns full content snapshot');
  assertEqual(syncData.content, 'ABCDE', 'Content snapshot is correct');
}

console.log('\n19. Sync returns snapshot-only when history is too old (Req 4):');
{
  const dm = new DocumentManager();
  const doc = dm.getOrCreateDocument('doc-old', '');
  doc.history = [];
  doc.version = 100;
  doc.content = 'Latest Content';

  for (let i = 0; i < 10; i++) {
    doc.history.push(OT.createInsert(i, 'x', `hist-${i}`));
  }

  const syncData = dm.getSyncData('doc-old', 0);
  assertEqual(syncData.type, 'snapshot', 'Sync type is snapshot when history too old');
  assert(syncData.content, 'Returns full content snapshot');
  assertEqual(syncData.content, 'Latest Content', 'Snapshot content is correct');
  assertEqual(syncData.version, 100, 'Returns latest version');
  assert(syncData.skipped > 0, 'Reports skipped operation count');
  console.log(`    Skipped ${syncData.skipped} operations, returned snapshot`);
}

console.log('\n20. Sync from up-to-date version returns up-to-date (Req 4):');
{
  const dm = new DocumentManager();
  dm.addClient('doc-uptodate', 'client1', 'Hello');
  dm.submitOperation('doc-uptodate', 'client1', OT.createInsert(5, ' World'), 0);

  const syncData = dm.getSyncData('doc-uptodate', 1);
  assertEqual(syncData.type, 'up-to-date', 'Sync type is up-to-date');
  assertEqual(syncData.operations.length, 0, 'No operations returned');
  assertEqual(syncData.version, 1, 'Version matches');
}

console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}

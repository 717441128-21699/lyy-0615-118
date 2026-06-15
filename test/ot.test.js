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

console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}

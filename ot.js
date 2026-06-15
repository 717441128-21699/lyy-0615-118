class OperationalTransform {
  static createInsert(position, chars, id = null) {
    return { type: 'insert', position, chars, id };
  }

  static createDelete(position, length, id = null) {
    return { type: 'delete', position, length, id };
  }

  static apply(doc, op) {
    if (op.type === 'insert') {
      if (op.position < 0 || op.position > doc.length) {
        throw new Error(`Insert position ${op.position} out of bounds for doc length ${doc.length}`);
      }
      return doc.slice(0, op.position) + op.chars + doc.slice(op.position);
    } else if (op.type === 'delete') {
      if (op.position < 0 || op.position + op.length > doc.length) {
        throw new Error(`Delete at ${op.position} length ${op.length} out of bounds for doc length ${doc.length}`);
      }
      return doc.slice(0, op.position) + doc.slice(op.position + op.length);
    }
    throw new Error(`Unknown operation type: ${op.type}`);
  }

  static transform(op1, op2) {
    if (op1.type === 'insert' && op2.type === 'insert') {
      return this._transformInsertInsert(op1, op2);
    } else if (op1.type === 'insert' && op2.type === 'delete') {
      return this._transformInsertDelete(op1, op2);
    } else if (op1.type === 'delete' && op2.type === 'insert') {
      return this._transformDeleteInsert(op1, op2);
    } else if (op1.type === 'delete' && op2.type === 'delete') {
      return this._transformDeleteDelete(op1, op2);
    }
    throw new Error(`Unknown operation types: ${op1.type}, ${op2.type}`);
  }

  static _transformInsertInsert(op1, op2) {
    const newOp1 = { ...op1 };
    const newOp2 = { ...op2 };

    if (op1.position < op2.position) {
      newOp2.position = op2.position + op1.chars.length;
    } else if (op1.position > op2.position) {
      newOp1.position = op1.position + op2.chars.length;
    } else {
      if (op1.id && op2.id && op1.id < op2.id) {
        newOp2.position = op2.position + op1.chars.length;
      } else {
        newOp1.position = op1.position + op2.chars.length;
      }
    }

    return [newOp1, newOp2];
  }

  static _transformInsertDelete(insertOp, deleteOp) {
    const newInsert = { ...insertOp };
    const newDelete = { ...deleteOp };

    if (insertOp.position <= deleteOp.position) {
      newDelete.position = deleteOp.position + insertOp.chars.length;
    } else if (insertOp.position >= deleteOp.position + deleteOp.length) {
      newInsert.position = insertOp.position - deleteOp.length;
    } else {
      newInsert.position = deleteOp.position;
      const beforeCount = insertOp.position - deleteOp.position;
      newDelete.length = deleteOp.length + insertOp.chars.length;
      newDelete.position = deleteOp.position + beforeCount;
      throw new Error('Overlapping insert and delete not fully handled');
    }

    return [newInsert, newDelete];
  }

  static _transformDeleteInsert(deleteOp, insertOp) {
    const [newInsert, newDelete] = this._transformInsertDelete(insertOp, deleteOp);
    return [newDelete, newInsert];
  }

  static _transformDeleteDelete(op1, op2) {
    const newOp1 = { ...op1 };
    const newOp2 = { ...op2 };

    const op1Start = op1.position;
    const op1End = op1.position + op1.length;
    const op2Start = op2.position;
    const op2End = op2.position + op2.length;

    if (op1End <= op2Start) {
      newOp2.position = op2.position - op1.length;
    } else if (op2End <= op1Start) {
      newOp1.position = op1.position - op2.length;
    } else {
      const overlapStart = Math.max(op1Start, op2Start);
      const overlapEnd = Math.min(op1End, op2End);
      const overlap = overlapEnd - overlapStart;

      if (op1Start <= op2Start) {
        newOp1.length = op1.length - overlap;
        newOp2.position = op1Start;
        newOp2.length = op2.length - overlap;
      } else {
        newOp2.length = op2.length - overlap;
        newOp1.position = op2Start;
        newOp1.length = op1.length - overlap;
      }

      if (newOp1.length < 0) newOp1.length = 0;
      if (newOp2.length < 0) newOp2.length = 0;
    }

    return [newOp1, newOp2];
  }

  static transformAgainstHistory(op, history) {
    let currentOp = { ...op };
    for (const histOp of history) {
      const [transformedHist, transformedCurrent] = this.transform(histOp, currentOp);
      currentOp = transformedCurrent;
    }
    return currentOp;
  }

  static compose(op1, op2) {
    if (op1.type === 'insert' && op2.type === 'delete') {
      if (op2.position >= op1.position && op2.position + op2.length <= op1.position + op1.chars.length) {
        const before = op1.chars.slice(0, op2.position - op1.position);
        const after = op1.chars.slice(op2.position - op1.position + op2.length);
        return { type: 'insert', position: op1.position, chars: before + after };
      }
    }
    return null;
  }
}

module.exports = OperationalTransform;

const OT = require('./ot');

class DocumentManager {
  constructor() {
    this.documents = new Map();
    this._opIdCounter = 0;
  }

  _generateOpId(clientId) {
    return `${String(this._opIdCounter++).padStart(10, '0')}-${clientId}`;
  }

  getOrCreateDocument(docId, initialContent = '') {
    if (!this.documents.has(docId)) {
      this.documents.set(docId, {
        content: initialContent,
        version: 0,
        history: [],
        clients: new Set(),
        pendingOps: [],
        snapshots: [initialContent]
      });
    }
    return this.documents.get(docId);
  }

  getDocument(docId) {
    return this.documents.get(docId) || null;
  }

  getDocumentState(docId) {
    const doc = this.getDocument(docId);
    if (!doc) return null;
    return {
      content: doc.content,
      version: doc.version
    };
  }

  addClient(docId, clientId, initialContent = '') {
    const existed = this.documents.has(docId);
    const doc = this.getOrCreateDocument(docId, initialContent);
    doc.clients.add(clientId);
    return {
      ...this.getDocumentState(docId),
      created: !existed
    };
  }

  removeClient(docId, clientId) {
    const doc = this.getDocument(docId);
    if (doc) {
      doc.clients.delete(clientId);
    }
  }

  submitOperation(docId, clientId, op, baseVersion, providedOpId = null) {
    const doc = this.getDocument(docId);
    if (!doc) {
      throw new Error(`Document ${docId} not found`);
    }

    if (baseVersion > doc.version) {
      throw new Error(`Base version ${baseVersion} is ahead of current version ${doc.version}`);
    }

    const opId = providedOpId || (op.id ? `${op.id}-${clientId}` : this._generateOpId(clientId));
    const opWithId = { ...op, id: opId };

    const pendingEntry = {
      clientId,
      op: opWithId,
      baseVersion,
      result: null
    };
    doc.pendingOps.push(pendingEntry);

    this._processPendingOps(doc);

    return pendingEntry.result;
  }

  _processPendingOps(doc) {
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;

      const readyOps = doc.pendingOps.filter(p => p.baseVersion <= doc.version && p.result === null);
      if (readyOps.length === 0) break;

      const minBase = Math.min(...readyOps.map(p => p.baseVersion));
      const sameBaseReady = readyOps.filter(p => p.baseVersion === minBase);

      if (minBase === doc.version) {
        sameBaseReady.sort((a, b) => (a.op.id || '').localeCompare(b.op.id || ''));
        const entry = sameBaseReady[0];
        entry.result = this._applySingleOperation(doc, entry.clientId, entry.op, entry.baseVersion);
        madeProgress = true;
        continue;
      }

      const entry = sameBaseReady[0];
      const histAtBase = doc.history.slice(0, minBase);
      const histAfterBase = doc.history.slice(minBase);

      const replayOps = [];
      for (const h of histAfterBase) replayOps.push({ source: 'history', op: h });
      for (const p of sameBaseReady) {
        if (p.baseVersion === minBase) replayOps.push({ source: 'pending', op: p.op, entry: p });
      }
      replayOps.sort((a, b) => (a.op.id || '').localeCompare(b.op.id || ''));

      doc.version = minBase;
      doc.content = doc.snapshots[minBase];
      doc.history = histAtBase.slice();
      doc.snapshots = doc.snapshots.slice(0, minBase + 1);

      const pendingResults = new Map();

      for (const item of replayOps) {
        const transformed = OT.transformAgainstHistory({ ...item.op },
          doc.history.slice(minBase));

        let applied = true;
        let applyError = null;
        try {
          doc.content = OT.apply(doc.content, transformed);
        } catch (e) {
          applied = false;
          applyError = e.message;
        }

        if (applied) {
          doc.history.push(transformed);
          doc.snapshots.push(doc.content);
          doc.version++;
        }

        if (item.source === 'pending') {
          const overlapInfo = [];
          for (const histOp of histAfterBase) {
            if ((item.op.type === 'insert' && histOp.type === 'delete') ||
                (item.op.type === 'delete' && histOp.type === 'insert')) {
              const insPos = item.op.type === 'insert' ? item.op.position : histOp.position;
              const delStart = item.op.type === 'delete' ? item.op.position : histOp.position;
              const delEnd = item.op.type === 'delete' ? item.op.position + item.op.length : histOp.position + histOp.length;
              if (insPos > delStart && insPos < delEnd) {
                overlapInfo.push({
                  type: 'insert_preserved_at_boundary',
                  withOpId: histOp.id,
                  originalInsertPosition: insPos,
                  newPosition: transformed.position,
                  preserved: true,
                  boundary: 'start'
                });
              }
            }
          }
          pendingResults.set(item.op.id, {
            applied,
            originalOp: { ...item.op },
            transformedOp: transformed,
            baseVersion: minBase,
            newVersion: doc.version,
            overlapInfo,
            applyError
          });
        }
      }

      for (const p of sameBaseReady) {
        p.result = pendingResults.get(p.op.id) || {
          applied: false, originalOp: { ...p.op }, transformedOp: p.op,
          baseVersion: minBase, newVersion: doc.version, overlapInfo: [],
          applyError: 'Not applied during replay'
        };
      }

      madeProgress = true;
    }

    doc.pendingOps = doc.pendingOps.filter(p => p.result === null);
  }

  _applySingleOperation(doc, clientId, op, baseVersion) {
    let transformedOp = { ...op };
    const overlapInfo = [];

    if (baseVersion < doc.version) {
      const historySince = doc.history.slice(baseVersion);
      for (const histOp of historySince) {
        if ((op.type === 'insert' && histOp.type === 'delete') ||
            (op.type === 'delete' && histOp.type === 'insert')) {
          const insPos = op.type === 'insert' ? op.position : histOp.position;
          const delStart = op.type === 'delete' ? op.position : histOp.position;
          const delEnd = op.type === 'delete' ? op.position + op.length : histOp.position + histOp.length;
          if (insPos > delStart && insPos < delEnd) {
            overlapInfo.push({
              type: 'insert_preserved_at_boundary',
              withOpId: histOp.id,
              originalInsertPosition: insPos,
              newPosition: null,
              preserved: true,
              boundary: 'start'
            });
          }
        }
      }
      transformedOp = OT.transformAgainstHistory(transformedOp, historySince);
      for (const info of overlapInfo) {
        info.newPosition = transformedOp.position;
      }
    }

    let applied = true;
    let applyError = null;
    try {
      doc.content = OT.apply(doc.content, transformedOp);
    } catch (e) {
      applied = false;
      applyError = e.message;
    }

    if (applied) {
      doc.version++;
      doc.history.push(transformedOp);
      doc.snapshots.push(doc.content);

      while (doc.snapshots.length > 500 && doc.history.length > 500) {
        doc.snapshots.shift();
      }
    }

    return {
      applied,
      originalOp: { ...op },
      transformedOp,
      baseVersion,
      newVersion: doc.version,
      overlapInfo,
      applyError
    };
  }

  getOperationsSince(docId, version) {
    const doc = this.getDocument(docId);
    if (!doc) return [];
    if (version >= doc.version) return [];
    const startIndex = version - (doc.version - doc.history.length);
    if (startIndex < 0) return [];
    return doc.history.slice(startIndex);
  }

  getSnapshot(docId) {
    const doc = this.getDocument(docId);
    if (!doc) return null;
    return {
      content: doc.content,
      version: doc.version
    };
  }

  getSyncData(docId, clientVersion) {
    const doc = this.getDocument(docId);
    if (!doc) return null;

    if (clientVersion >= doc.version) {
      return {
        type: 'up-to-date',
        version: doc.version,
        content: doc.content,
        baseContent: doc.snapshots[doc.version] || doc.content,
        operations: []
      };
    }

    const oldestAvailableVersion = doc.version - doc.history.length;
    const hasFullHistory = clientVersion >= oldestAvailableVersion;

    const oldestSnapshotVersion = doc.version - (doc.snapshots.length - 1);
    let baseContent;
    if (clientVersion >= oldestSnapshotVersion && clientVersion < doc.snapshots.length) {
      baseContent = doc.snapshots[clientVersion];
    } else if (doc.snapshots.length > 0) {
      baseContent = doc.snapshots[doc.snapshots.length - 1];
    } else {
      baseContent = doc.content;
    }

    if (hasFullHistory) {
      const operations = this.getOperationsSince(docId, clientVersion);
      return {
        type: 'incremental',
        version: doc.version,
        baseVersion: clientVersion,
        operations,
        content: doc.content,
        baseContent
      };
    } else {
      return {
        type: 'snapshot',
        version: doc.version,
        content: doc.content,
        baseContent: doc.content,
        operations: [],
        skipped: oldestAvailableVersion - clientVersion
      };
    }
  }

  getClientCount(docId) {
    const doc = this.getDocument(docId);
    return doc ? doc.clients.size : 0;
  }

  getAllDocuments() {
    const result = [];
    for (const [id, doc] of this.documents.entries()) {
      result.push({
        id,
        version: doc.version,
        contentLength: doc.content.length,
        clientCount: doc.clients.size
      });
    }
    return result;
  }
}

module.exports = DocumentManager;

const OT = require('./ot');

class DocumentManager {
  constructor() {
    this.documents = new Map();
  }

  getOrCreateDocument(docId, initialContent = '') {
    if (!this.documents.has(docId)) {
      this.documents.set(docId, {
        content: initialContent,
        version: 0,
        history: [],
        clients: new Set()
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

  addClient(docId, clientId) {
    const doc = this.getOrCreateDocument(docId);
    doc.clients.add(clientId);
    return this.getDocumentState(docId);
  }

  removeClient(docId, clientId) {
    const doc = this.getDocument(docId);
    if (doc) {
      doc.clients.delete(clientId);
    }
  }

  submitOperation(docId, clientId, op, baseVersion) {
    const doc = this.getDocument(docId);
    if (!doc) {
      throw new Error(`Document ${docId} not found`);
    }

    if (baseVersion > doc.version) {
      throw new Error(`Base version ${baseVersion} is ahead of current version ${doc.version}`);
    }

    let transformedOp = { ...op, id: `${clientId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` };

    if (baseVersion < doc.version) {
      const historySince = doc.history.slice(baseVersion);
      transformedOp = OT.transformAgainstHistory(transformedOp, historySince);
    }

    let applied = true;
    try {
      doc.content = OT.apply(doc.content, transformedOp);
    } catch (e) {
      applied = false;
      console.error('Failed to apply operation:', e.message);
    }

    if (applied) {
      doc.version++;
      doc.history.push(transformedOp);

      if (doc.history.length > 1000) {
        doc.history = doc.history.slice(-500);
      }
    }

    return {
      applied,
      transformedOp,
      newVersion: doc.version
    };
  }

  getOperationsSince(docId, version) {
    const doc = this.getDocument(docId);
    if (!doc) return [];
    if (version >= doc.version) return [];
    return doc.history.slice(version);
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

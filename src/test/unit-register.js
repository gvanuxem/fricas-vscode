const Module = require('module')
const originalLoad = Module._load

class DummyClass {}

class Range {
    constructor(startLine, startChar, endLine, endChar) {
        this.start = { line: startLine, character: startChar }
        this.end = { line: endLine, character: endChar }
    }
}

class EventEmitter {
    constructor() {
        this.event = () => ({ dispose() {} })
    }
    fire() {}
    dispose() {}
}

const noopProxy = (overrides = {}) => new Proxy(overrides, {
    get(target, prop) {
        if (prop in target) return target[prop]
        return () => ({ dispose() {} })
    }
})

const vscodeBase = {
    Range,
    Position: class {
        constructor(line, character) {
            this.line = line
            this.character = character
        }
    },
    EventEmitter,
    MarkdownString: class {
        constructor(value = '') { this.value = value }
        appendMarkdown(s) { this.value += s }
    },
    Disposable: class {
        static from() { return { dispose() {} } }
        dispose() {}
    },
    Uri: {
        file: (p) => ({ fsPath: p, toString: () => `file://${p}` }),
        parse: (s) => ({ toString: () => s })
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: { Field: 7, Package: 3, Interface: 10, Class: 4, Constant: 13, Function: 11, Operator: 24, Variable: 12, TypeParameter: 25 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    languages: noopProxy({
        createDiagnosticCollection: () => noopProxy()
    }),
    commands: noopProxy({
        executeCommand: () => Promise.resolve()
    }),
    window: noopProxy({
        createOutputChannel: () => noopProxy(),
        createStatusBarItem: () => noopProxy(),
        visibleTextEditors: []
    }),
    workspace: noopProxy({
        getConfiguration: () => ({ get: () => undefined })
    }),
    tasks: noopProxy(),
    notebooks: noopProxy(),
    extensions: noopProxy()
}

const vscodeMock = new Proxy(vscodeBase, {
    get(target, prop) {
        if (prop in target) return target[prop]
        if (typeof prop === 'string' && /^[A-Z]/.test(prop)) {
            return DummyClass
        }
        return noopProxy()
    }
})

Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return vscodeMock
    }
    return originalLoad.apply(this, arguments)
}

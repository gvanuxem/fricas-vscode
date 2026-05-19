import * as fs from 'async-file'
import { assert } from 'console'
import { homedir } from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import * as rpc from 'vscode-jsonrpc/node'
import * as vslc from 'vscode-languageclient/node'
import { onSetLanguageClient } from '../extension'
import { switchEnvToPath } from '../spadpkgenv'
import { FriCASExecutablesFeature } from '../fricasexepath'
import { getVersionedParamsAtPosition, registerCommand, setContext, wrapCrashReporting } from '../utils'
import * as completions from './completions'
import { VersionedTextDocumentPositionParams } from './misc'
import * as modules from './modules'
import * as plots from './plots'
import * as results from './results'
import { Frame, openFile } from './results'

//let g_context: vscode.ExtensionContext = null
let g_languageClient: vslc.LanguageClient = null
//let g_compiledProvider = null

let g_terminal: vscode.Terminal = null
let g_pty: FriCASPseudoTerminal = null

export let g_connection: rpc.MessageConnection = undefined

let g_fricasExecutablesFeature: FriCASExecutablesFeature

/**
 * Wraps a VS Code LanguageClient to expose a MessageConnection-compatible
 * interface.  This lets all existing consumers (completions, workspace,
 * documentation, …) keep using `g_connection.sendRequest(type, params)`
 * without changes — under the hood the calls go to the single Language
 * Server process that was started with `--mcp`.
 */
class LanguageClientConnection {
    constructor(private client: vslc.LanguageClient) {}

    sendRequest(type: any, ...args: any[]) {
        const method = typeof type === 'string' ? type : type.method
        return this.client.sendRequest(method, ...args)
    }

    sendNotification(type: any, ...args: any[]) {
        const method = typeof type === 'string' ? type : type.method
        return this.client.sendNotification(method, ...args)
    }

    onNotification(type: any, handler: any): vscode.Disposable {
        const method = typeof type === 'string' ? type : type.method
        return this.client.onNotification(method, handler)
    }

    onRequest(type: any, handler: any): vscode.Disposable {
        const method = typeof type === 'string' ? type : type.method
        return this.client.onRequest(method, handler)
    }

    listen() { /* no-op — LanguageClient already listening */ }
    end() { /* no-op — lifecycle managed by extension.ts */ }
    dispose() { /* no-op */ }
}

/**
 * Interactive pseudo-terminal for the FriCAS REPL.
 *
 * Instead of spawning a second FriCAS process, this PTY displays
 * evaluation results received from the Language Server and accepts
 * user input which is forwarded as `tools/call evaluate` requests.
 */
class FriCASPseudoTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>()
    private closeEmitter = new vscode.EventEmitter<void | number>()
    onDidWrite = this.writeEmitter.event
    onDidClose = this.closeEmitter.event

    private inputBuffer = ''
    private history: string[] = []
    private historyIndex = -1
    private evaluating = false

    constructor(private version: string) {}

    open() {
        this.writeEmitter.fire(`\x1b[1mFriCAS REPL (v${this.version})\x1b[0m\r\n`)
        this.showPrompt()
    }

    close() { /* terminal closed by user */ }

    private showPrompt() {
        this.writeEmitter.fire('\r\n\x1b[32m-> \x1b[0m')
    }

    handleInput(data: string) {
        if (this.evaluating) {
            if (data === '\x03') { softInterrupt() }
            return
        }
        for (let i = 0; i < data.length; i++) {
            const ch = data[i]
            if (ch === '\r') {
                this.writeEmitter.fire('\r\n')
                if (this.inputBuffer.trim()) {
                    this.history.push(this.inputBuffer)
                    this.historyIndex = this.history.length
                    this.doEvaluate(this.inputBuffer)
                } else {
                    this.showPrompt()
                }
                this.inputBuffer = ''
            } else if (ch === '\x7f') { // Backspace
                if (this.inputBuffer.length > 0) {
                    this.inputBuffer = this.inputBuffer.slice(0, -1)
                    this.writeEmitter.fire('\b \b')
                }
            } else if (ch === '\x03') { // Ctrl+C
                this.writeEmitter.fire('^C')
                this.inputBuffer = ''
                this.showPrompt()
            } else if (ch === '\x1b' && data.length > i + 2) {
                const seq = data.substring(i, i + 3)
                if (seq === '\x1b[A') { // Up arrow
                    i += 2
                    if (this.historyIndex > 0) {
                        this.historyIndex--
                        this.replaceInput(this.history[this.historyIndex])
                    }
                } else if (seq === '\x1b[B') { // Down arrow
                    i += 2
                    if (this.historyIndex < this.history.length - 1) {
                        this.historyIndex++
                        this.replaceInput(this.history[this.historyIndex])
                    } else {
                        this.historyIndex = this.history.length
                        this.replaceInput('')
                    }
                } else {
                    i += 2 // skip unknown escape sequences
                }
            } else {
                this.inputBuffer += ch
                this.writeEmitter.fire(ch)
            }
        }
    }

    private replaceInput(text: string) {
        const clearLen = this.inputBuffer.length
        this.writeEmitter.fire('\r\x1b[32m-> \x1b[0m' + ' '.repeat(clearLen) + '\r\x1b[32m-> \x1b[0m')
        this.inputBuffer = text
        this.writeEmitter.fire(text)
    }

    private async doEvaluate(code: string) {
        if (!g_connection) {
            this.writeOutput('Error: Not connected to FriCAS.\n')
            return
        }
        this.evaluating = true
        try {
            const result = await g_connection.sendRequest(
                requestTypeCallTool,
                { name: 'evaluate', arguments: { expression: code } }
            )
            const output = result.content[0].text
            if (output && output.trim()) {
                this.writeOutput(output)
            }
        } catch (err) {
            this.writeOutput(`Error: ${err.message || err}`)
        }
        this.evaluating = false
        this.showPrompt()
    }

    /** Write text to the terminal (converts \\n to \\r\\n). */
    writeOutput(text: string) {
        this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'))
    }

    /** Write error text in red to the terminal. */
    writeError(text: string) {
        this.writeEmitter.fire('\x1b[31m' + text.replace(/\r?\n/g, '\r\n') + '\x1b[0m')
    }

    /** Echoes an editor-triggered evaluation to the terminal. */
    echoEvaluation(code: string, output: string, isError = false) {
        this.writeEmitter.fire('\r\x1b[2K')
        this.writeEmitter.fire(`\x1b[90m-> ${code.replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`)
        if (output && output.trim()) {
            const formattedOutput = output.replace(/\r?\n/g, '\r\n')
            if (isError) {
                this.writeEmitter.fire('\x1b[31m' + formattedOutput + '\x1b[0m\r\n')
            } else {
                this.writeEmitter.fire(formattedOutput + '\r\n')
            }
        }
        this.writeEmitter.fire('\x1b[32m-> \x1b[0m' + this.inputBuffer)
    }
}


function startREPLCommand() {
    startREPL(false, true)
}
async function stopREPL(onDeactivate = false) {
    if (isConnected()) {
        g_onExit.fire(false)
        g_connection = undefined
    }
    if (g_terminal) {
        g_terminal.dispose()
        g_terminal = null
    }
    g_pty = null
}
async function restartREPL() {
    await stopREPL()
    await startREPL(false, true)
}
function isConnected() {
    return Boolean(g_connection)
}

async function startREPL(preserveFocus: boolean, showTerminal: boolean = true) {
    if (isConnected()) {
        if (g_terminal && showTerminal) {
            g_terminal.show(preserveFocus)
        }
        return
    }

    // The LanguageClient IS the FriCAS process (started with --mcp).
    // We just wrap it to look like a MessageConnection.
    if (!g_languageClient) {
        vscode.window.showErrorMessage(
            'FriCAS Language Server is not started yet. Please wait for it to initialize.'
        )
        return
    }

    g_connection = new LanguageClientConnection(g_languageClient) as any

    if (g_terminal === null) {
        const fricasExecutable = await g_fricasExecutablesFeature.getActiveFriCASExecutableAsync()
        const version = fricasExecutable ? String(fricasExecutable.getVersion()) : 'unknown'

        // Create an interactive pseudo-terminal for REPL display + input
        g_pty = new FriCASPseudoTerminal(version)
        g_terminal = vscode.window.createTerminal({
            name: `FriCAS REPL (v${version})`,
            pty: g_pty,
            isTransient: true,
        } as any)

        g_terminal.show(preserveFocus)
    } else if (showTerminal) {
        g_terminal.show(preserveFocus)
    }

    // Fire onInit so that completions, workspace, modules etc. activate
    g_onInit.fire(g_connection)
}

/*
function debuggerRun(params: DebugLaunchParams) {
    vscode.debug.startDebugging(undefined, {
        type: 'fricas',
        request: 'attach',
        name: 'FriCAS REPL',
        code: params.code,
        file: params.filename,
        stopOnEntry: false,
        compiledModulesOrFunctions: g_compiledProvider.getCompiledItems(),
        compiledMode: g_compiledProvider.compiledMode
    })
}

function debuggerEnter(params: DebugLaunchParams) {
    vscode.debug.startDebugging(undefined, {
        type: 'fricas',
        request: 'attach',
        name: 'FriCAS REPL',
        code: params.code,
        file: params.filename,
        stopOnEntry: true,
        compiledModulesOrFunctions: g_compiledProvider.getCompiledItems(),
        compiledMode: g_compiledProvider.compiledMode
    })
}
*/
interface ReturnResult {
    inline: string,
    all: string,
    stackframe: null | Array<Frame>
}

const requestTypeReplRunCode = new rpc.RequestType<{
    filename: string,
    line: number,
    column: number,
    code: string,
    mod: string,
    showCodeInREPL: boolean,
    showResultInREPL: boolean,
    showErrorInREPL: boolean,
    softscope: boolean
}, ReturnResult, void>('repl/runcode')

export const requestTypeGetDocFromWord = new rpc.RequestType<{ word: string, type?: string }, string, void>('repl/getDocFromWord')
export const requestTypeGetDocAt = new rpc.RequestType<VersionedTextDocumentPositionParams & { word?: string, type?: string }, string, void>('repl/getDocAt')

export const requestTypeCallTool = new rpc.RequestType<{ name: string, arguments: any }, { content: { type: string, text: string }[] }, void>('tools/call')

/*
interface DebugLaunchParams {
    code: string,
    filename: string
}*/

export const notifyTypeDisplay = new rpc.NotificationType<{ kind: string, data: any }>('display')
//const notifyTypeDebuggerEnter = new rpc.NotificationType<DebugLaunchParams>('debugger/enter')
//const notifyTypeDebuggerRun = new rpc.NotificationType<DebugLaunchParams>('debugger/run')
//const notifyTypeReplStartDebugger = new rpc.NotificationType<{ debugPipename: string }>('repl/startdebugger')
const notifyTypeReplStartEval = new rpc.NotificationType<void>('repl/starteval')
export const notifyTypeReplFinishEval = new rpc.NotificationType<void>('repl/finisheval')
export const notifyTypeReplShowInGrid = new rpc.NotificationType<{ code: string }>('repl/showingrid')
//const notifyTypeShowProfilerResult = new rpc.NotificationType<{ trace: any, typ: string }>('repl/showprofileresult')
const notifyTypeOpenFile = new rpc.NotificationType<{ path: string, line: number }>('repl/openFile')

interface Progress {
    id: { value: number },
    name: string,
    fraction: number,
    done: Boolean
}
const notifyTypeProgress = new rpc.NotificationType<Progress>('repl/updateProgress')

const g_onInit = new vscode.EventEmitter<rpc.MessageConnection>()
export const onInit = g_onInit.event
const g_onExit = new vscode.EventEmitter<Boolean>()
export const onExit = g_onExit.event
const g_onStartEval = new vscode.EventEmitter<null>()
export const onStartEval = g_onStartEval.event
const g_onFinishEval = new vscode.EventEmitter<null>()
export const onFinishEval = g_onFinishEval.event

// code execution start

const g_progress_dict = {}

async function updateProgress(progress: Progress) {
    if (g_progress_dict[progress.id.value]) {
        const p = g_progress_dict[progress.id.value]
        const increment = progress.done ? 100 : (progress.fraction - p.last_fraction) * 100

        p.progress.report({
            increment: increment,
            message: progressMessage(progress, p.started)
        })
        p.last_fraction = progress.fraction

        if (progress.done) {
            p.resolve()
            delete g_progress_dict[progress.id.value]
        }
    } else {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'FriCAS',
            cancellable: true
        }, (prog, token) => {
            return new Promise(resolve => {
                g_progress_dict[progress.id.value] = {
                    progress: prog,
                    last_fraction: progress.fraction,
                    started: new Date(),
                    resolve: resolve,
                }
                token.onCancellationRequested(ev => {
                    interrupt()
                })
                prog.report({
                    message: progressMessage(progress)
                })
            })
        })
    }
}

function progressMessage(prog: Progress, started = null) {
    let message = prog.name
    const parenthezise = message.trim().length > 0
    if (isFinite(prog.fraction) && 0 <= prog.fraction && prog.fraction <= 1) {
        if (parenthezise) {
            message += ' ('
        }
        message += `${(prog.fraction * 100).toFixed(1)}%`
        if (started !== null) {
            const elapsed = ((new Date()).valueOf() - started) / 1000
            const remaining = (1 / prog.fraction - 1) * elapsed
            if (isFinite(remaining)) {
                message += ` - ${formattedTimePeriod(remaining)} remaining`
            }
        }
        if (parenthezise) {
            message += ')'
        }
    }
    return message
}

function formattedTimePeriod(t) {
    const seconds = Math.floor(t % 60)
    const minutes = Math.floor(t / 60 % 60)
    const hours = Math.floor(t / 60 / 60)
    let out = ''
    if (hours > 0) {
        out += `${hours}h, `
    }
    if (minutes > 0) {
        out += `${minutes}min, `
    }
    out += `${seconds}s`
    return out
}

function clearProgress() {
    for (const id in g_progress_dict) {
        g_progress_dict[id].resolve()
        delete g_progress_dict[id]
    }
}

function display(params: { kind: string, data: any }) {
    if (params.kind === 'application/vnd.fricas-vscode.diagnostics') {
        displayDiagnostics(params.data)
    } else {
        plots.displayPlot(params)
    }
}

interface diagnosticData {
    msg: string,
    path: string,
    line?: number,
    range?: number[][],
    severity: number,
    relatedInformation?: {
        msg: string,
        path: string,
        line?: number,
        range?: number[][]
    }[]
}
const g_trace_diagnostics: Map<string, vscode.DiagnosticCollection> = new Map()
function displayDiagnostics(data: { source: string, items: diagnosticData[] }) {
    const source = data.source

    if (g_trace_diagnostics.has(source)) {
        g_trace_diagnostics.get(source).clear()
    } else {
        g_trace_diagnostics.set(source, vscode.languages.createDiagnosticCollection('FriCAS Runtime Diagnostics: ' + source))
    }

    const items = data.items
    if (items.length === 0) {
        return _clearDiagnostic(source)
    }

    const diagnostics = items.map((frame): [vscode.Uri, vscode.Diagnostic[]] => {
        const range = frame.range ?
            new vscode.Range(frame.range[0][0] - 1, frame.range[0][1], frame.range[1][0] - 1, frame.range[1][1]) :
            new vscode.Range(frame.line - 1, 0, frame.line - 1, 99999)
        const diagnostic = new vscode.Diagnostic(
            range,
            frame.msg,
            frame.severity === undefined ? vscode.DiagnosticSeverity.Warning : frame.severity
        )
        if (frame.relatedInformation) {
            diagnostic.relatedInformation = frame.relatedInformation.map(stackframe => {
                const range = stackframe.range ?
                    new vscode.Range(stackframe.range[0][0] - 1, stackframe.range[0][1], stackframe.range[1][0] - 1, stackframe.range[1][1]) :
                    new vscode.Range(stackframe.line - 1, 0, stackframe.line - 1, 99999)
                return new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(vscode.Uri.file(stackframe.path), range),
                    stackframe.msg
                )
            })
        }
        diagnostic.source = source

        return [
            vscode.Uri.file(frame.path),
            [
                diagnostic
            ]
        ]
    })
    g_trace_diagnostics.get(source).set(diagnostics)
}

function clearDiagnostics() {
    g_trace_diagnostics.forEach((_, source) => _clearDiagnostic(source))
}

function clearDiagnosticsByProvider() {
    const sources = Array(...g_trace_diagnostics.keys())
    vscode.window.showQuickPick(sources, {
        // canPickMany: true, // not work nicely with keyboard shortcuts
        title: 'Select sources of diagnostics to filter them out.'
    }).then(source => {
        if (source) {
            _clearDiagnostic(source)
        }
    })
}

function _clearDiagnostic(source: string) {
    const diagnostics = g_trace_diagnostics.get(source)
    diagnostics.clear()
    diagnostics.dispose()
    g_trace_diagnostics.delete(source)
}

function stripMarkdown(code: string) {
    let out = ''
    let isFriCAS = false
    for (const line of code.split('\n')) {
        if (/^```fricas/.test(line)) {
            isFriCAS = true
            out += '\n'
            continue
        }
        if (isFriCAS) {
            if (/^```/.test(line)) {
                isFriCAS = false
                out += '\n'
                continue
            }
            out += line + '\n'
        } else {
            out += '\n'
        }
    }
    return out
}

async function executeFile(uri?: vscode.Uri | string) {
    const editor = vscode.window.activeTextEditor

    await startREPL(true, false)

    let module = 'Main'
    let path = ''
    let code = ''

    if (uri && !(uri instanceof vscode.Uri)) {
        uri = vscode.Uri.parse(uri)
    }

    let isJmd = false

    if (uri && uri instanceof vscode.Uri) {
        path = uri.fsPath
        const readBytes = await vscode.workspace.fs.readFile(uri)
        code = Buffer.from(readBytes).toString('utf8')
        isJmd = path.endsWith('.jmd') || path.endsWith('.md')
    } else {
        if (!editor) {
            return
        }
        path = editor.document.fileName
        code = editor.document.getText()

        const pos = editor.document.validatePosition(new vscode.Position(0, 1))
        module = await modules.getModuleForEditor(editor.document, pos)
        isJmd = isMarkdownEditor(editor)
    }

    // For .input files, delegate to FriCAS's )read command.
    if (path.endsWith('.input') && !isJmd) {
        const readCmd = `)read ${path}`
        try {
            const result = await g_connection.sendRequest(
                requestTypeCallTool,
                {
                    name: 'evaluate',
                    arguments: { expression: readCmd }
                }
            )
            const output = result.content[0].text
            if (g_pty) {
                g_pty.echoEvaluation(readCmd, output)
            }
        } catch (err) {
            if (g_pty) {
                g_pty.echoEvaluation(readCmd, `Error: ${err.message || err}`, true)
            }
        }
        return
    }

    // strip out non-code-block content for JMD files:
    if (isJmd) {
        code = stripMarkdown(code)
    }

    try {
        const result = await g_connection.sendRequest(
            requestTypeReplRunCode,
            {
                filename: path,
                line: 0,
                column: 0,
                mod: module,
                code: code,
                showCodeInREPL: true,
                showResultInREPL: true,
                showErrorInREPL: true,
                softscope: false
            }
        )
        if (g_pty && result) {
            const output = result.all || result.inline
            g_pty.echoEvaluation(`)read ${path}`, output)
        }
    } catch (err) {
        if (g_pty) {
            g_pty.echoEvaluation(`)read ${path}`, `Error: ${err.message || err}`, true)
        }
    }
}

async function getBlockRange(params: VersionedTextDocumentPositionParams): Promise<vscode.Position[]> {
    const zeroPos = new vscode.Position(0, 0)
    const zeroReturn = [zeroPos, zeroPos, params.position]

    try {
        return (await g_languageClient.sendRequest<vscode.Position[]>('fricas/getCurrentBlockRange', params)).map(pos => new vscode.Position(pos.line, pos.character))
    } catch (err) {
        if (err.message === 'Language client is not ready yet') {
            vscode.window.showErrorMessage(err.message)
        } else {
            console.error(err)
            vscode.window.showErrorMessage('Error while communicating with the LS. Check Outputs > FriCAS Language Server for additional information.')
        }
        return zeroReturn
    }
}

async function selectFriCASBlock() {

    const editor = vscode.window.activeTextEditor
    const position = editor.document.validatePosition(editor.selection.start)
    const ret_val = await getBlockRange(getVersionedParamsAtPosition(editor.document, position))

    const start_pos = new vscode.Position(ret_val[0].line, ret_val[0].character)
    const end_pos = new vscode.Position(ret_val[1].line, ret_val[1].character)
    validateMoveAndReveal(editor, start_pos, end_pos)
}

let g_cellDelimiters = [
    /^##(?!#)/,
    /^#(\s?)%%/
]

function isCellBorder(s: string, isStart: boolean, isJmd: boolean) {
    if (isJmd) {
        if (isStart) {
            return /^```fricas/.test(s)
        } else {
            return /^```(?!\w)/.test(s)
        }
    }
    return g_cellDelimiters.some(regex => regex.test(s))
}

function _nextCellBorder(doc: vscode.TextDocument, line: number, direction: number, isStart: boolean, isJmd: boolean) {
    assert(direction === 1 || direction === -1)
    while (0 <= line && line < doc.lineCount) {
        if (isCellBorder(doc.lineAt(line).text, isStart, isJmd)) {
            break
        }
        line += direction
    }
    return line
}

const nextCellBorder = (doc, line, isStart, isJmd) => _nextCellBorder(doc, line, +1, isStart, isJmd)
const prevCellBorder = (doc, line, isStart, isJmd) => _nextCellBorder(doc, line, -1, isStart, isJmd)

function validateMoveAndReveal(editor: vscode.TextEditor, startpos: vscode.Position, endpos: vscode.Position) {
    const doc = editor.document
    startpos = doc.validatePosition(startpos)
    endpos = doc.validatePosition(endpos)
    editor.selection = new vscode.Selection(startpos, endpos)
    editor.revealRange(new vscode.Range(startpos, endpos))
}

async function moveCellDown() {
    const ed = vscode.window.activeTextEditor
    if (ed === undefined) {
        return
    }
    const isJmd = isMarkdownEditor(ed)
    const currline = ed.selection.active.line
    const newpos = new vscode.Position(nextCellBorder(ed.document, currline + 1, true, isJmd) + 1, 0)
    validateMoveAndReveal(ed, newpos, newpos)
}

async function moveCellUp() {
    const ed = vscode.window.activeTextEditor
    if (ed === undefined) {
        return
    }
    const isJmd = isMarkdownEditor(ed)
    const currline = ed.selection.active.line

    let newpos: vscode.Position
    if (isJmd) {
        const prevEnd = Math.max(0, prevCellBorder(ed.document, currline, false, isJmd))
        const prevStart = Math.max(0, prevCellBorder(ed.document, currline, true, isJmd))

        if (prevEnd <= prevStart) {
            newpos = new vscode.Position(Math.max(0, prevCellBorder(ed.document, prevStart - 1, true, isJmd) + 1), 0)
        } else {
            newpos = new vscode.Position(prevStart + 1, 0)
        }
    } else {
        newpos = new vscode.Position(Math.max(0, prevCellBorder(ed.document, currline, true, isJmd) - 1), 0)
    }
    validateMoveAndReveal(ed, newpos, newpos)
}

function currentCellRange(editor: vscode.TextEditor) {
    const doc = editor.document
    const currline = editor.selection.active.line
    const isJmd = isMarkdownEditor(editor)
    const startline = prevCellBorder(doc, currline, true, isJmd) + 1
    if (isJmd && startline === 0) {
        return null
    }
    const endline = nextCellBorder(doc, startline + 1, false, isJmd) - 1
    if (startline > currline || endline < currline) {
        return null
    }
    const startpos = doc.validatePosition(new vscode.Position(startline, 0))
    const endpos = doc.validatePosition(new vscode.Position(endline, doc.lineAt(endline).text.length))
    return new vscode.Range(startpos, endpos)
}

async function executeCell(shouldMove: boolean = false) {

    const ed = vscode.window.activeTextEditor
    if (ed === undefined) {
        return
    }
    if (vscode.workspace.getConfiguration('fricas').get<boolean>('execution.saveOnEval') === true) {
        await ed.document.save()
    }

    const doc = ed.document
    const selection = ed.selection
    const cellrange = currentCellRange(ed)
    if (cellrange === null) {
        return
    }

    const module: string = await modules.getModuleForEditor(ed.document, cellrange.start)

    await startREPL(true, false)

    if (shouldMove && ed.selection === selection) {
        const isJmd = isMarkdownEditor(ed)
        const nextpos = new vscode.Position(nextCellBorder(doc, cellrange.end.line + 1, true, isJmd) + 1, 0)
        validateMoveAndReveal(ed, nextpos, nextpos)
    }
    if (vscode.workspace.getConfiguration('fricas').get<boolean>('execution.inlineResultsForCellEvaluation') === true) {
        let currentPos: vscode.Position = ed.document.validatePosition(new vscode.Position(cellrange.start.line, cellrange.start.character + 1))
        let lastRange = new vscode.Range(0, 0, 0, 0)
        while (currentPos.line <= cellrange.end.line) {
            const [startPos, endPos, nextPos] = await getBlockRange(getVersionedParamsAtPosition(ed.document, currentPos))
            const lineEndPos = ed.document.validatePosition(new vscode.Position(endPos.line, Infinity))
            const curRange = cellrange.intersection(new vscode.Range(startPos, lineEndPos))
            if (curRange === undefined || curRange.isEqual(lastRange)) {
                break
            }
            lastRange = curRange
            if (curRange.isEmpty) {
                continue
            }
            currentPos = ed.document.validatePosition(nextPos)
            const code = doc.getText(curRange)

            const success = await evaluate(ed, curRange, code, module)
            if (!success) {
                break
            }
        }
    } else {
        const code = doc.getText(cellrange)
        await evaluate(ed, cellrange, code, module)
    }
}

async function evaluateBlockOrSelection(shouldMove: boolean = false) {

    const editor = vscode.window.activeTextEditor
    if (editor === undefined) {
        return
    }

    if (editor.document.languageId !== 'fricas' && !isMarkdownEditor(editor)) {
        vscode.window.showWarningMessage('The current file is not set to FriCAS language. Execution might fail or be disabled.')
    }

    if (vscode.workspace.getConfiguration('fricas').get<boolean>('execution.saveOnEval') === true) {
        await editor.document.save()
    }
    const selections = editor.selections.slice()

    await startREPL(true, false)

    for (const selection of selections) {
        let range: vscode.Range = null
        let nextBlock: vscode.Position = null
        const cursorPos: vscode.Position = editor.document.validatePosition(new vscode.Position(selection.start.line, selection.start.character))
        const module: string = await modules.getModuleForEditor(editor.document, cursorPos)

        if (selection.isEmpty) {
            const [startPos, endPos, nextPos] = await getBlockRange(getVersionedParamsAtPosition(editor.document, cursorPos))
            const blockStartPos = editor.document.validatePosition(startPos)
            const lineEndPos = editor.document.validatePosition(new vscode.Position(endPos.line, Infinity))
            range = new vscode.Range(blockStartPos, lineEndPos)
            nextBlock = editor.document.validatePosition(nextPos)
        } else {
            range = new vscode.Range(selection.start, selection.end)
        }

        const text = editor.document.getText(range)

        if (shouldMove && nextBlock && selection.isEmpty && editor.selections.length === 1 && editor.selection === selection) {
            validateMoveAndReveal(editor, nextBlock, nextBlock)
        }

        if (range.isEmpty) {
            return
        }

        const tempDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
            isWholeLine: true
        })
        editor.setDecorations(tempDecoration, [range])

        setTimeout(() => {
            editor.setDecorations(tempDecoration, [])
        }, 200)

        const success = await evaluate(editor, range, text, module)

        if (!success) {
            break
        }
    }
}

// Returns false if the connection wasn't available
async function evaluate(editor: vscode.TextEditor, range: vscode.Range, text: string, module: string) {
    const section = vscode.workspace.getConfiguration('fricas')
    const resultType: string = section.get('execution.resultType')

    if (!g_connection) {
        return false
    }

    // Echo the code to the REPL terminal
    if (g_pty) {
        g_pty.writeOutput(`\x1b[90m${text}\x1b[0m\n`)
    }

    let r: results.Result = null
    if (resultType !== 'REPL') {
        r = results.addResult(editor, range, ' ⟳ ', '')
    }
    console.log(`Sending RPC request tools/call for evaluate: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`)
    try {
        const result = await g_connection.sendRequest(
            requestTypeCallTool,
            {
                name: 'evaluate',
                arguments: { expression: text }
            }
        )
        console.log(`Received RPC response for evaluate tool`)
        const output = result.content[0].text
        const isError = output.startsWith('Evaluation Error:') || output.startsWith('Julia Evaluation Error:')

        // Echo the result to the REPL terminal
        if (g_pty && output && output.trim()) {
            if (isError) {
                g_pty.writeError(output + '\n')
            } else {
                g_pty.writeOutput(output + '\n')
            }
        }

        if (resultType !== 'REPL') {
            if (r.destroyed && r.text === editor.document.getText(r.range)) {
                r = results.addResult(editor, range, '', '')
            }
            if (isError) {
                results.clearStackTrace()
                // results.setStackTrace(r, output, result.stackframe) // stackframe is null for tool
            }
            r.setContent(results.resultContent(' ' + output + ' ', output, isError))
        }

        return !isError
    } catch (err) {
        if (g_pty) {
            g_pty.writeError(`Error: ${err.message || err}\n`)
        }
        if (r) { r.remove(true) }
        throw (err)
    }
}

async function executeCodeCopyPaste(text: string, individualLine: boolean) {
    text = text.trim()
    if (!text) { return }

    await startREPL(true, true)
    if (!g_connection) { return }

    try {
        const result = await g_connection.sendRequest(
            requestTypeCallTool,
            { name: 'evaluate', arguments: { expression: text } }
        )
        const output = result.content[0].text
        if (g_pty) {
            g_pty.echoEvaluation(text, output)
        }
    } catch (err) {
        if (g_pty) {
            g_pty.echoEvaluation(text, `Error: ${err.message || err}`, true)
        }
    }
}

function executeSelectionCopyPaste() {

    const editor = vscode.window.activeTextEditor
    if (!editor) {
        return
    }

    const selection = editor.selection

    const text = selection.isEmpty ? editor.document.lineAt(selection.start.line).text : editor.document.getText(selection)

    // If no text was selected, try to move the cursor to the end of the next line
    if (selection.isEmpty) {
        for (let line = selection.start.line + 1; line < editor.document.lineCount; line++) {
            if (!editor.document.lineAt(line).isEmptyOrWhitespace) {
                const newPos = selection.active.with(line, editor.document.lineAt(line).range.end.character)
                const newSel = new vscode.Selection(newPos, newPos)
                editor.selection = newSel
                break
            }
        }
    }
    executeCodeCopyPaste(text, selection.isEmpty)
}

export async function executeInREPL(code: string): Promise<ReturnResult> {
    await startREPL(true)
    const result = await g_connection.sendRequest(
        requestTypeCallTool,
        {
            name: 'evaluate',
            arguments: { expression: code }
        }
    )
    const output = result.content[0].text
    return {
        inline: output,
        all: output,
        stackframe: null
    }
}

async function interrupt() {
    await softInterrupt()
}

async function softInterrupt() {
    try {
        await g_connection.sendNotification('repl/interrupt')
    } catch (err) {
        console.warn(err)
    }
}

// code execution end

async function cdToHere(uri: vscode.Uri) {

    const uriPath = await getDirUriFsPath(uri)
    await startREPL(true, false)
    if (uriPath) {
        try {
            await g_connection.sendNotification('repl/cd', { uri: uriPath })
        } catch (err) {
            console.log(err)
        }
    }
}

async function activateHere(uri: vscode.Uri) {

    const uriPath = await getDirUriFsPath(uri)
    activatePath(uriPath)
}

async function activatePath(path: string) {
    await startREPL(true, false)
    if (path) {
        try {
            await g_connection.sendNotification('repl/activateProject', { uri: path })
            switchEnvToPath(path, true)
        } catch (err) {
            console.log(err)
        }
    }
}

async function activateFromDir(uri: vscode.Uri) {
    const uriPath = await getDirUriFsPath(uri)
    if (uriPath) {
        try {
            const target = await searchUpFile('Project.toml', uriPath)
            if (!target) {
                vscode.window.showWarningMessage(`No project file found for ${uriPath}`)
                return
            }
            activatePath(path.dirname(target))
        } catch (err) {
            console.log(err)
        }
    }
}

async function searchUpFile(target: string, from: string): Promise<string> {
    const parentDir = path.dirname(from)
    if (parentDir === from) {
        return undefined // ensure to escape infinite recursion
    } else {
        const p = path.join(from, target)
        return (await fs.exists(p)) ? p : searchUpFile(target, parentDir)
    }
}

async function getDirUriFsPath(uri: vscode.Uri | undefined) {
    if (!uri) {
        const ed = vscode.window.activeTextEditor
        if (ed && ed.document && ed.document.uri) {
            uri = ed.document.uri
        }
    }
    if (!uri || !uri.fsPath) {
        return undefined
    }

    const uriPath = uri.fsPath
    const stat = await fs.stat(uriPath)
    if (stat.isFile()) {
        return path.dirname(uriPath)
    } else if (stat.isDirectory()) {
        return uriPath
    } else {
        return undefined
    }
}

async function linkHandler(link: any) {
    let file = link.data.file
    const line = link.data.line

    if (file.startsWith('.')) {
        // Base file
        const exe = await g_fricasExecutablesFeature.getActiveFriCASExecutableAsync()
        file = path.join(await exe.getBaseRootFolderPathAsync(), file)
    } else if (file.startsWith('~')) {
        file = path.join(homedir(), file.slice(1))
    }
    try {
        await openFile(file, line)
    } catch (err) {
        console.debug('This file does not exist.')
    }
}

function linkProvider(context: vscode.TerminalLinkContext, token: vscode.CancellationToken) {
    const line = context.line
    // Can't link to the REPL
    if (/\bREPL\[\d+\]/.test(line)) {
        return []
    }

    const match = line.match(/(@\s+(?:[^\s/\\]+\s+)?)(.+?):(\d+)/)
    if (match) {
        return [
            {
                startIndex: match.index + match[1].length,
                length: match[0].length - match[1].length,
                data: {
                    file: match[2],
                    line: match[3]
                }
            }
        ]
    }
    return []
}

function updateCellDelimiters() {
    const delims: string[] = vscode.workspace.getConfiguration('fricas').get('cellDelimiters')
    if (delims) {
        g_cellDelimiters = delims.map(s => RegExp(s))
    }
}

function isMarkdownEditor(editor: vscode.TextEditor) {
    return editor.document.languageId === 'fricasmarkdown' || editor.document.languageId === 'markdown'
}

export async function replStartDebugger(pipename: string) {
    await startREPL(true)

    //await g_connection.sendNotification(notifyTypeReplStartDebugger, { debugPipename: pipename })
}

export function activate(context: vscode.ExtensionContext, fricasExecutablesFeature: FriCASExecutablesFeature) {
    //g_context = context
    g_fricasExecutablesFeature = fricasExecutablesFeature

    context.subscriptions.push(
        // listeners
        onSetLanguageClient(languageClient => {
            g_languageClient = languageClient
        }),
        onInit(wrapCrashReporting(connection => {
            connection.onNotification(notifyTypeDisplay, display)
            //connection.onNotification(notifyTypeDebuggerRun, debuggerRun)
            //connection.onNotification(notifyTypeDebuggerEnter, debuggerEnter)
            connection.onNotification(notifyTypeReplStartEval, () => g_onStartEval.fire(null))
            connection.onNotification(notifyTypeReplFinishEval, () => g_onFinishEval.fire(null))
            //connection.onNotification(notifyTypeShowProfilerResult, (data) => profilerFeature.showTrace({
            //    data: data.trace,
            //    type: data.typ
            //}))
            connection.onNotification(notifyTypeOpenFile, ({ path, line }) => openFile(path, line))
            connection.onNotification(notifyTypeProgress, updateProgress)
            setContext('fricas.isEvaluating', false)
            setContext('fricas.hasREPL', true)
        })),
        onExit(() => {
            results.removeAll()
            clearDiagnostics()
            setContext('fricas.isEvaluating', false)
            setContext('fricas.hasREPL', false)
        }),
        onStartEval(() => {
            updateProgress({
                name: 'Evaluating…',
                id: { value: -1 },
                fraction: -1,
                done: false
            })
            setContext('fricas.isEvaluating', true)
        }),
        onFinishEval(() => {
            clearProgress()
            setContext('fricas.isEvaluating', false)
        }),
        vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration('fricas.usePlotPane')) {
                try {
                    await g_connection.sendNotification('repl/togglePlotPane', { enable: vscode.workspace.getConfiguration('fricas').get('usePlotPane') })
                } catch (err) {
                    console.warn(err)
                }
            } else if (event.affectsConfiguration('fricas.useProgressFrontend')) {
                try {
                    await g_connection.sendNotification('repl/toggleProgress', { enable: vscode.workspace.getConfiguration('fricas').get('useProgressFrontend') })
                } catch (err) {
                    console.warn(err)
                }
            } else if (event.affectsConfiguration('fricas.showRuntimeDiagnostics')) {
                try {
                    await g_connection.sendNotification('repl/toggleDiagnostics', { enable: vscode.workspace.getConfiguration('fricas').get('showRuntimeDiagnostics') })
                } catch (err) {
                    console.warn(err)
                }
            } else if (event.affectsConfiguration('fricas.cellDelimiters')) {
                updateCellDelimiters()
            }
        }),
        vscode.window.onDidChangeActiveTerminal(terminal => {
            if (terminal === g_terminal) {
                setContext('fricas.isActiveREPL', true)
            } else {
                setContext('fricas.isActiveREPL', false)
            }
        }),
        vscode.window.onDidCloseTerminal(terminal => {
            if (terminal === g_terminal) {
                g_terminal = null
            }
        }),
        // link handler
        vscode.window.registerTerminalLinkProvider({
            provideTerminalLinks: linkProvider,
            handleTerminalLink: linkHandler
        }),
        // commands
        registerCommand('language-fricas.startREPL', startREPLCommand),
        registerCommand('language-fricas.stopREPL', stopREPL),
        registerCommand('language-fricas.restartREPL', restartREPL),
        registerCommand('language-fricas.selectBlock', selectFriCASBlock),
        registerCommand('language-fricas.executeCodeBlockOrSelection', evaluateBlockOrSelection),
        registerCommand('language-fricas.executeCodeBlockOrSelectionAndMove', () => evaluateBlockOrSelection(true)),
        registerCommand('language-fricas.executeCell', executeCell),
        registerCommand('language-fricas.executeCellAndMove', () => executeCell(true)),
        registerCommand('language-fricas.moveCellUp', moveCellUp),
        registerCommand('language-fricas.moveCellDown', moveCellDown),
        registerCommand('language-fricas.executeActiveFile', () => executeFile()),
        registerCommand('language-fricas.executeFile', uri => executeFile(uri)),
        registerCommand('language-fricas.interrupt', interrupt),
        registerCommand('language-fricas.executeFriCASCodeInREPL', executeSelectionCopyPaste), // copy-paste selection into REPL. doesn't require LS to be started
        registerCommand('language-fricas.cdHere', cdToHere),
        registerCommand('language-fricas.activateHere', activateHere),
        registerCommand('language-fricas.activateFromDir', activateFromDir),
        registerCommand('language-fricas.clearRuntimeDiagnostics', clearDiagnostics),
        registerCommand('language-fricas.clearRuntimeDiagnosticsByProvider', clearDiagnosticsByProvider),
    )

    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated')
    const shellSkipCommands: Array<String> = terminalConfig.get('commandsToSkipShell')
    if (shellSkipCommands.indexOf('language-fricas.interrupt') === -1) {
        shellSkipCommands.push('language-fricas.interrupt')
        terminalConfig.update('commandsToSkipShell', shellSkipCommands, true)
    }

    updateCellDelimiters()

    results.activate(context)
    plots.activate(context)
    modules.activate(context)
    completions.activate(context)
}

export function deactivate() {
    return stopREPL(true)
}

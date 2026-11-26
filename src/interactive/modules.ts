import * as vscode from 'vscode'
import * as rpc from 'vscode-jsonrpc'
import { registerCommand, wrapCrashReporting } from '../utils'
import { onExit, onInit } from './repl'

let statusBarItem: vscode.StatusBarItem | null = null
let g_connection: rpc.MessageConnection | null = null
let g_currentGetModuleRequestCancelTokenSource: vscode.CancellationTokenSource | undefined = undefined

const manuallySetDocuments: Record<string, string> = {}

const requestTypeGetModules = new rpc.RequestType<void, string[], void>('repl/loadedModules')
const requestTypeIsModuleLoaded = new rpc.RequestType<{ mod: string }, boolean, void>('repl/isModuleLoaded')

const automaticallyChooseOption = 'Choose Automatically'


export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(ed => {
        cancelCurrentGetModuleRequest()
        g_currentGetModuleRequestCancelTokenSource = new vscode.CancellationTokenSource()
        updateStatusBarItem(ed, g_currentGetModuleRequestCancelTokenSource.token)
    }))
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(changeEvent => {
        cancelCurrentGetModuleRequest()
        g_currentGetModuleRequestCancelTokenSource = new vscode.CancellationTokenSource()
        updateModuleForSelectionEvent(changeEvent, g_currentGetModuleRequestCancelTokenSource.token)
    }))
    context.subscriptions.push(registerCommand('language-fricas.chooseModule', chooseModule))

    // NOTE:
    // set module status bar item just right of language mode selector
    // ref: language selector has priority `100`:
    // https://github.com/microsoft/vscode/blob/1d268b701376470bc638100fbe17d283404ac559/src/vs/workbench/browser/parts/editor/editorStatus.ts#L534
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
    statusBarItem.command = 'language-fricas.chooseModule'
    statusBarItem.tooltip = 'Choose Current Module'

    onInit(wrapCrashReporting(conn => {
        g_connection = conn
        updateStatusBarItem()
    }))
    onExit(hadError => {
        g_connection = null
        updateStatusBarItem()
    })

    context.subscriptions.push(statusBarItem)
    updateStatusBarItem()
}

function cancelCurrentGetModuleRequest() {
    if (g_currentGetModuleRequestCancelTokenSource) {
        g_currentGetModuleRequestCancelTokenSource.cancel()
        g_currentGetModuleRequestCancelTokenSource = undefined
    }
}

export function inferSpadConstructorAtLine(getLineText: (line: number) => string, line: number): string {
    const abbrevRegex = /^\s*\)abbrev\s+(?:domain|package|category)\s+\S+\s+([^\s(]+)/
    for (let i = line; i >= 0; i--) {
        const match = getLineText(i).match(abbrevRegex)
        if (match && match[1]) {
            return match[1]
        }
    }
    return 'Main'
}

export async function getModuleForEditor(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<string> {
    const manuallySetModule = manuallySetDocuments[document.fileName]
    if (manuallySetModule) { return manuallySetModule }

    return inferSpadConstructorAtLine(line => document.lineAt(line).text, position.line)
}

function isFriCASEditor(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor) {
    return editor && editor.document.languageId === 'fricas'
}

async function updateStatusBarItem(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor, token?: vscode.CancellationToken) {
    if (isFriCASEditor(editor) && editor) {
        statusBarItem?.show()
        await updateModuleForEditor(editor, token)
    } else {
        statusBarItem?.hide()
    }
}

async function updateModuleForSelectionEvent(event: vscode.TextEditorSelectionChangeEvent, token?: vscode.CancellationToken) {
    const editor = event.textEditor
    await updateStatusBarItem(editor, token)
}

async function updateModuleForEditor(editor: vscode.TextEditor, token?: vscode.CancellationToken) {
    const mod = await getModuleForEditor(editor.document, editor.selection.start, token)
    if (mod) {
        const loaded = await isModuleLoaded(mod)
        if (statusBarItem) {
            statusBarItem.text = loaded ? mod : '(' + mod + ')'
        }
    }
}

async function isModuleLoaded(mod: string) {
    if (!g_connection) { return false }
    try {
        return await g_connection.sendRequest(requestTypeIsModuleLoaded, { mod: mod })
    } catch (err) {
        return false
    }
}

async function chooseModule() {
    if (!g_connection) {
        vscode.window.showInformationMessage('Setting a module requires an active REPL.')
        return
    }
    let possibleModules: string[] = []
    try {
        possibleModules = await g_connection.sendRequest(requestTypeGetModules, undefined)
    } catch (err) {
        return
    }

    possibleModules.sort()
    possibleModules.splice(0, 0, automaticallyChooseOption)

    const qpOptions: vscode.QuickPickOptions = {
        placeHolder: 'Select module',
        canPickMany: false
    }
    const mod = await vscode.window.showQuickPick(possibleModules, qpOptions)
    if (!mod) { return }

    const ed = vscode.window.activeTextEditor
    if (ed) {
        if (mod === automaticallyChooseOption) {
            delete manuallySetDocuments[ed.document.fileName]
        } else {
            manuallySetDocuments[ed.document.fileName] = mod
        }
    }

    cancelCurrentGetModuleRequest()
    g_currentGetModuleRequestCancelTokenSource = new vscode.CancellationTokenSource()
    updateStatusBarItem(ed, g_currentGetModuleRequestCancelTokenSource.token)
}

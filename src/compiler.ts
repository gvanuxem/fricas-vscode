import * as path from 'path'
import * as vscode from 'vscode'
import { registerCommand } from './utils'
import { echoREPLEvaluation, g_connection, requestTypeCallTool, startREPL } from './interactive/repl'

export const fricasDiagnosticCollection = vscode.languages.createDiagnosticCollection('fricas-compiler')

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        fricasDiagnosticCollection,
        registerCommand('language-fricas.compileSpadFile', (uri?: vscode.Uri) => compileFile(uri, 'spad')),
        registerCommand('language-fricas.compileBootFile', (uri?: vscode.Uri) => compileFile(uri, 'boot')),
        registerCommand('language-fricas.compileLispFile', (uri?: vscode.Uri) => compileFile(uri, 'lisp'))
    )
}

async function getTargetUri(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (uri && uri instanceof vscode.Uri) {
        return uri
    }
    const editor = vscode.window.activeTextEditor
    if (editor) {
        if (editor.document.isDirty) {
            await editor.document.save()
        }
        return editor.document.uri
    }
    return undefined
}

export interface CompilerDiagnostic {
    line: number
    message: string
    isError: boolean
}

export function parseDiagnosticLines(output: string): CompilerDiagnostic[] {
    const diagnostics: CompilerDiagnostic[] = []
    const lines = output.split('\n')
    const lineRegex = /(?:line\s+(\d+)|\[(\d+)\]|on\s+line\s+(\d+))/i
    const errorRegex = /(?:error|fatal|syntax\s+error)/i
    const warnRegex = /(?:warning|caution)/i

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const lineMatch = line.match(lineRegex)
        if (lineMatch) {
            const lineNumStr = lineMatch[1] || lineMatch[2] || lineMatch[3]
            const lineNum = Math.max(0, parseInt(lineNumStr, 10) - 1)
            const isError = errorRegex.test(line)
            const isWarn = warnRegex.test(line)

            if (isError || isWarn) {
                diagnostics.push({
                    line: lineNum,
                    message: line.trim(),
                    isError: isError
                })
            }
        }
    }
    return diagnostics
}

function parseSpadDiagnostics(output: string, targetUri: vscode.Uri) {
    const parsed = parseDiagnosticLines(output)
    const diagnostics: vscode.Diagnostic[] = parsed.map(d => {
        const range = new vscode.Range(d.line, 0, d.line, 999)
        const severity = d.isError ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
        return new vscode.Diagnostic(range, d.message, severity)
    })
    fricasDiagnosticCollection.set(targetUri, diagnostics)
}

async function compileFile(uri?: vscode.Uri, kind: 'spad' | 'boot' | 'lisp' = 'spad') {
    const targetUri = await getTargetUri(uri)
    if (!targetUri) {
        vscode.window.showWarningMessage(`No active ${kind.toUpperCase()} file to compile.`)
        return
    }

    const filePath = targetUri.fsPath
    await startREPL(true, false)

    if (!g_connection) {
        vscode.window.showErrorMessage('FriCAS server is not connected.')
        return
    }

    const toolName = kind === 'spad' ? 'compile-spad' : kind === 'boot' ? 'compile-boot' : 'compile-lisp'
    const commandLabel = `)compile ${path.basename(filePath)}`

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `FriCAS: Compiling ${path.basename(filePath)}…`,
            cancellable: false
        },
        async () => {
            try {
                const result = await g_connection.sendRequest(requestTypeCallTool, {
                    name: toolName,
                    arguments: { path: filePath }
                })
                const output = result?.content?.[0]?.text ?? ''
                const isError = output.includes('Error') || output.includes('FATAL')

                await echoREPLEvaluation(commandLabel, output, isError)

                if (kind === 'spad') {
                    parseSpadDiagnostics(output, targetUri)
                }

                if (isError) {
                    vscode.window.showErrorMessage(`Compilation of ${path.basename(filePath)} failed. See REPL for details.`)
                } else {
                    vscode.window.showInformationMessage(`Successfully compiled ${path.basename(filePath)}.`)
                }
            } catch (err: any) {
                const errMsg = err?.message || String(err)
                await echoREPLEvaluation(commandLabel, `Error: ${errMsg}`, true)
                vscode.window.showErrorMessage(`Compilation error: ${errMsg}`)
            }
        }
    )
}

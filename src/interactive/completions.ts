// provides completions and signature helps using dynamic information

import * as vscode from 'vscode'
import * as rpc from 'vscode-jsonrpc'
import { Disposable, MessageConnection } from 'vscode-jsonrpc'
import { wrapCrashReporting } from '../utils'
import { getModuleForEditor } from './modules'
import { onExit, onInit, requestTypeGetDocFromWord } from './repl'

const selector = [
    { language: 'fricas', scheme: 'untitled' },
    { language: 'fricas', scheme: 'file' }
]
const completionTriggerCharacters = [
    '\.', // property/field completion
    '[', // dict completion
]
export function activate(context: vscode.ExtensionContext) {
    let completionSubscription: undefined | Disposable = undefined
    context.subscriptions.push(
        onInit(wrapCrashReporting(conn => {
            completionSubscription = vscode.languages.registerCompletionItemProvider(
                selector,
                completionItemProvider(conn),
                ...completionTriggerCharacters
            )
        })),
        onExit(() => {
            if (completionSubscription) { completionSubscription.dispose() }
        })
    )
}

const requestTypeGetCompletionItems = new rpc.RequestType<
    { line: string, mod: string }, // input type
    vscode.CompletionItem[], // return type
    void
>('repl/getcompletions')

function completionItemProvider(conn: MessageConnection): vscode.CompletionItemProvider {
    return {
        provideCompletionItems: async (document, position, token, context) => {
            if (!vscode.workspace.getConfiguration('fricas').get('runtimeCompletions')) {
                return
            }
            const completionPromise = (async () => {
                try {
                    const startPosition = new vscode.Position(position.line, 0)
                    const lineRange = new vscode.Range(startPosition, position)
                    const line = document.getText(lineRange)

                    const mod: string = await getModuleForEditor(document, position)
                    if (token.isCancellationRequested) { return }

                    const items = await conn.sendRequest(requestTypeGetCompletionItems, { line, mod })
                    if (token.isCancellationRequested) { return }

                    return {
                        items: items,
                        isIncomplete: true
                    }
                }
                catch (err) {
                    throw (err)
                }
            })()

            const cancelPromise: Promise<vscode.CompletionList> = new Promise(resolve => {
                token.onCancellationRequested(() => resolve({
                    items: [],
                    isIncomplete: true
                }))
                setTimeout(() => {
                    if (!token.isCancellationRequested) {
                        resolve({
                            items: [],
                            isIncomplete: true
                        })
                    }
                }, 500)
            })

            return Promise.race([
                completionPromise,
                cancelPromise
            ])
        },
        resolveCompletionItem: async (item, token) => {
            if (item.documentation) {
                return item
            }
            const word = item.label as string
            try {
                let doc = await conn.sendRequest(requestTypeGetDocFromWord, { word })
                if (!doc || doc.trim().length === 0) {
                    doc = await conn.sendRequest(requestTypeGetDocFromWord, { word, type: 'constructor' })
                }
                if (doc && doc.trim().length > 0) {
                    const md = new vscode.MarkdownString(doc as string)
                    const commandUri = vscode.Uri.parse(`command:language-fricas.search-word?${encodeURIComponent(JSON.stringify({ searchTerm: word }))}`)
                    md.appendMarkdown(`\n\n---\n\n[Show in Documentation Pane](${commandUri.toString()})`)
                    md.isTrusted = true
                    item.documentation = md
                }
            } catch (err) {
                // Ignore errors during documentation lookup
            }
            return item
        }
    }
}

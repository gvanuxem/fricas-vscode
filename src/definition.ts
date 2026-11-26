import * as fs from 'async-file'
import * as path from 'path'
import * as vscode from 'vscode'
import { FriCASExecutablesFeature } from './fricasexepath'
import { g_connection, requestTypeCallTool } from './interactive/repl'

export class FriCASDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private fricasExecutablesFeature: FriCASExecutablesFeature) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location | undefined> {
        const wordRange = document.getWordRangeAtPosition(position)
        if (!wordRange) { return undefined }

        const word = document.getText(wordRange)
        if (!/^[A-Z][A-Za-z0-9]*$/.test(word) || !g_connection || token.isCancellationRequested) {
            return undefined
        }

        try {
            const res = await g_connection.sendRequest(requestTypeCallTool, {
                name: 'evaluate',
                arguments: { expression: `)lisp (GETDATABASE (INTERN "${word}" "BOOT") 'SOURCEFILE)` }
            })
            const raw = res?.content?.[0]?.text ?? ''
            const match = raw.match(/"([^"]+\.spad)"/i)
            if (!match || !match[1]) {
                return undefined
            }

            const exe = await this.fricasExecutablesFeature.getActiveFriCASExecutableAsync()
            if (!exe) { return undefined }

            const baseRoot = await exe.getBaseRootFolderPathAsync()
            const candidates = [
                path.join(baseRoot, 'src', 'algebra', match[1]),
                path.join(baseRoot, 'share', 'spad', match[1]),
                match[1]
            ]

            for (const candidate of candidates) {
                if (await fs.exists(candidate)) {
                    const uri = vscode.Uri.file(candidate)
                    const text = await fs.readTextFile(candidate)
                    const lineIdx = text.split('\n').findIndex(l =>
                        new RegExp(`^\\s*\\)abbrev\\s+\\S+\\s+\\S+\\s+${word}\\b`).test(l)
                    )
                    const pos = new vscode.Position(Math.max(0, lineIdx), 0)
                    return new vscode.Location(uri, pos)
                }
            }
        } catch {
            // Ignore definition lookup failures
        }

        return undefined
    }
}

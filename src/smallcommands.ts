import * as fs from 'async-file'
import * as path from 'path'
import * as vscode from 'vscode'
import { registerCommand } from './utils'

/*
function toggleLinter() {
    telemetry.traceEvent('command-togglelinter')

    const cval = vscode.workspace.getConfiguration('fricas').get('lint.run', false)
    vscode.workspace.getConfiguration('fricas').update('lint.run', !cval, true)
}*/

function applyTextEdit(we) {

    const wse = new vscode.WorkspaceEdit()
    for (const edit of we.documentChanges[0].edits) {
        wse.replace(we.documentChanges[0].textDocument.uri, new vscode.Range(edit.range.start.line, edit.range.start.character, edit.range.end.line, edit.range.end.character), edit.newText)
    }
    vscode.workspace.applyEdit(wse)
}

// function lintPackage() {
//     telemetry.traceEvent('command-lintpackage');

//     if (g_languageClient == null) {
//         vscode.window.showErrorMessage('Error: package linting only works with a running fricas language server.');
//     }
//     else {
//         try {
//             g_languageClient.sendRequest("fricas/lint-package");
//         }
//         catch (ex) {
//             if (ex.message == "Language client is not ready yet") {
//                 vscode.window.showErrorMessage('Error: package linting only works with a running fricas language server.');
//             }
//             else {
//                 throw ex;
//             }
//         }
//     }
// }

async function newFriCASFile(uri?: vscode.Uri) {
    if (uri) {
        const stat = await vscode.workspace.fs.stat(uri)
        const dir = stat.type === vscode.FileType.Directory ? uri.fsPath : path.dirname(uri.fsPath)
        const defaultName = path.join(dir, 'untitled.spad')
        const givenPath = await vscode.window.showInputBox({
            value: defaultName,
            valueSelection: [dir.length + 1, defaultName.length - 3], // select file name
            prompt: 'Enter a file path to be created',
            validateInput: async input => {
                const givenPath = vscode.Uri.file(input).fsPath
                const exist = await fs.exists(givenPath)
                if (exist) { return `${givenPath} already exists` }
                const givenDir = path.dirname(givenPath)
                const dirExist = await fs.exists(givenDir)
                if (!dirExist) { return `Directory ${givenDir} doesn't exist` }
                return undefined // valid
            }
        })
        if (!givenPath) { return } // canceled, etc
        const targetUri = vscode.Uri.file(givenPath)
        try {
            await fs.writeTextFile(targetUri.fsPath, '')
            const document = await vscode.workspace.openTextDocument(targetUri)
            await vscode.languages.setTextDocumentLanguage(document, 'fricas')
            await vscode.window.showTextDocument(document)
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create ${targetUri.fsPath}`)
        }
    } else {
        // untitled editor
        const document = await vscode.workspace.openTextDocument({
            language: 'fricas'
        })
        await vscode.window.showTextDocument(document)
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        registerCommand('language-fricas.applytextedit', applyTextEdit),
        //registerCommand('language-fricas.toggleLinter', toggleLinter),
        registerCommand('language-fricas.newFriCASFile', newFriCASFile)
    )
}

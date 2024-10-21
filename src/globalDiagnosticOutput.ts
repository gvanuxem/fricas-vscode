import * as vscode from 'vscode'

export class FriCASGlobalDiagnosticOutputFeature {
    outputChannel: vscode.OutputChannel

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('FriCAS')
    }

    public dispose() {
    }

    public append(msg: string) {
        this.outputChannel.append(msg)
    }

    public appendLine(msg: string) {
        this.outputChannel.appendLine(msg)
    }
}

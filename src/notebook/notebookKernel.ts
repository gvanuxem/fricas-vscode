import { Subject } from 'await-notify'
import * as vscode from 'vscode'
import { CancellationToken } from 'vscode-jsonrpc/node'
import { FriCASExecutable } from '../fricasexepath'
import { FriCASNotebookFeature } from './notebookFeature'
import { g_connection, requestTypeCallTool, startREPL } from '../interactive/repl'

export class FriCASKernel {
    private _localDisposables: vscode.Disposable[] = []

    private _scheduledExecutionRequests: vscode.NotebookCellExecution[] = []
    private _currentExecutionRequest: vscode.NotebookCellExecution = null
    private _processExecutionRequests = new Subject()
    private _current_request_id: number = 0

    private _onCellRunFinished = new vscode.EventEmitter<void>()
    public onCellRunFinished = this._onCellRunFinished.event

    private _onConnected = new vscode.EventEmitter<void>()
    public onConnected = this._onConnected.event

    private _onStopped = new vscode.EventEmitter<void>()
    public onStopped = this._onStopped.event

    private _tokenSource = new vscode.CancellationTokenSource()
    private _isDisposed = false

    constructor(
        _extensionPath: string,
        public controller: vscode.NotebookController,
        public notebook: vscode.NotebookDocument,
        public fricasExecutable: FriCASExecutable,
        private outputChannel: vscode.OutputChannel,
        private notebookFeature: FriCASNotebookFeature
    ) {
        this.run(this._tokenSource.token)
    }

    public get _msgConnection() {
        return g_connection
    }

    public dispose() {
        if (this._isDisposed) { return }
        this._isDisposed = true
        this.stop()
        this._localDisposables.forEach((d) => d.dispose())
    }

    public appendCellOutput(items: { mimetype: string; data: any }[]) {
        const execution = this._currentExecutionRequest
        if (execution) {
            execution.appendOutput(
                new vscode.NotebookCellOutput(
                    items.map((item) => {
                        if (
                            item.mimetype === 'image/png' ||
                            item.mimetype === 'image/jpeg' ||
                            item.mimetype === 'image/gif'
                        ) {
                            return new vscode.NotebookCellOutputItem(
                                Buffer.from(item.data, 'base64'),
                                item.mimetype
                            )
                        } else if (item.mimetype === 'image/svg+xml') {
                            return vscode.NotebookCellOutputItem.text(
                                item.data,
                                item.mimetype
                            )
                        } else if (item.mimetype.endsWith('+json')) {
                            return vscode.NotebookCellOutputItem.json(
                                item.data,
                                item.mimetype
                            )
                        } else if (item.mimetype === 'fricasvscode/html' || item.mimetype === 'text/html') {
                            return vscode.NotebookCellOutputItem.text(
                                item.data,
                                'text/html'
                            )
                        } else {
                            return vscode.NotebookCellOutputItem.text(
                                item.data,
                                item.mimetype
                            )
                        }
                    })
                )
            )
        }
    }

    public async queueCell(cell: vscode.NotebookCell): Promise<void> {
        // Clear previous output
        const clearOutputExecution =
            this.controller.createNotebookCellExecution(cell)
        clearOutputExecution.start()
        await clearOutputExecution.clearOutput()
        clearOutputExecution.end(undefined)

        // Create execution object that actually will run the code
        const execution = this.controller.createNotebookCellExecution(cell)
        execution.token.onCancellationRequested(() => {
            execution.end(undefined)
            this.interrupt()
        })
        this._scheduledExecutionRequests.push(execution)

        this._processExecutionRequests.notify()
    }

    private async messageLoop(token: CancellationToken) {
        while (!this._isDisposed) {
            if (token.isCancellationRequested) {
                return
            }

            while (this._scheduledExecutionRequests.length > 0) {
                this._currentExecutionRequest =
                    this._scheduledExecutionRequests.shift()

                if (this._currentExecutionRequest.token.isCancellationRequested) {
                    this._currentExecutionRequest.end(undefined)
                } else {
                    const executionOrder = ++this._current_request_id
                    this._currentExecutionRequest.executionOrder = executionOrder

                    const runStartTime = Date.now()
                    this._currentExecutionRequest.start(runStartTime)

                    const code = this._currentExecutionRequest.cell.document.getText()
                    if (!code.trim()) {
                        this._currentExecutionRequest.end(true, Date.now())
                    } else {
                        try {
                            await startREPL(true)
                            if (!g_connection) {
                                throw new Error('Could not connect to FriCAS Language Server.')
                            }
                            const result = await g_connection.sendRequest(
                                requestTypeCallTool,
                                {
                                    name: 'evaluate',
                                    arguments: { expression: code }
                                }
                            )
                            const output = result?.content?.[0]?.text ?? ''
                            const isError = output.startsWith('Evaluation Error:') || output.startsWith('Julia Evaluation Error:')
                            if (isError) {
                                this._currentExecutionRequest.appendOutput([
                                    new vscode.NotebookCellOutput([
                                        vscode.NotebookCellOutputItem.error({
                                            name: 'FriCAS Error',
                                            message: output,
                                            stack: ''
                                        })
                                    ])
                                ])
                                this._currentExecutionRequest.end(false, Date.now())
                            } else {
                                if (output && output.trim()) {
                                    this._currentExecutionRequest.appendOutput([
                                        new vscode.NotebookCellOutput([
                                            vscode.NotebookCellOutputItem.text(output, 'text/plain')
                                        ])
                                    ])
                                }
                                this._currentExecutionRequest.end(true, Date.now())
                            }
                        } catch (err: any) {
                            this._currentExecutionRequest.appendOutput([
                                new vscode.NotebookCellOutput([
                                    vscode.NotebookCellOutputItem.error({
                                        name: 'Execution Error',
                                        message: err.message || String(err),
                                        stack: err.stack || ''
                                    })
                                ])
                            ])
                            this._currentExecutionRequest.end(false, Date.now())
                        }
                    }
                }
                this._currentExecutionRequest = null

                this._onCellRunFinished.fire()

                if (token.isCancellationRequested) {
                    return
                }
            }

            await this._processExecutionRequests.wait()
        }
    }

    private async run(token: CancellationToken) {
        try {
            this.outputChannel.appendLine('FriCAS Notebook Kernel initialized.')
            this._onConnected.fire(null)
            await this.messageLoop(token)
            this._onStopped.fire(undefined)
        } catch (err) {
            this.outputChannel.appendLine(`FriCAS Notebook Kernel error: ${err}`)
            this._onStopped.fire(undefined)
        }
    }

    public async stop() {
        this._tokenSource.cancel()
        this._processExecutionRequests.notify()
        this._onStopped.fire(undefined)
    }

    public async restart() {
        this.notebookFeature.restart(this)
    }

    public async interrupt() {
        try {
            await vscode.commands.executeCommand('language-fricas.interrupt')
        } catch (err) {
            console.error('Interrupt error:', err)
        }
    }
}

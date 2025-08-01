/* eslint-disable semi */
import * as semver from 'semver'
import * as vscode from 'vscode'
import { NotebookNode, WorkspaceFeature } from '../interactive/workspace'
import { FriCASExecutable, FriCASExecutablesFeature } from '../fricasexepath'
import { registerCommand } from '../utils'
import { FriCASKernel } from './notebookKernel'

const JupyterNotebookViewType = 'jupyter-notebook'
type JupyterNotebookMetadata = Partial<{
    custom: {
        metadata: {
            kernelspec: {
                display_name: string
                language: string
                name: string
            }
            language_info: {
                name: string
                version: string
                mimetype: string
                file_extension: string
            }
        }
    }
}>

export class FriCASNotebookFeature {
    private readonly _controllers = new Map<
        vscode.NotebookController,
        FriCASExecutable
    >();
    private readonly kernels: Map<vscode.NotebookDocument, FriCASKernel> = new Map<
        vscode.NotebookDocument,
        FriCASKernel
    >();
    private _outputChannel: vscode.OutputChannel
    private readonly disposables: vscode.Disposable[] = [];
    private vscodeIpynbApi = undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private fricasExecutableFeature: FriCASExecutablesFeature,
        private workspaceFeature: WorkspaceFeature
    ) {
        this.init()

        vscode.workspace.onDidOpenNotebookDocument(
            this.onDidOpenNotebookDocument,
            this,
            this.disposables
        )

        context.subscriptions.push(
            registerCommand('language-fricas.stopKernel', (node) =>
                this.stopKernel(node)
            ),
            registerCommand('language-fricas.restartKernel', (node) =>
                this.restartKernel(node)
            )
        )
    }

    private async init() {
        this._outputChannel = vscode.window.createOutputChannel(
            'FriCAS Notebook Kernels'
        )

        const ext = vscode.extensions.getExtension('vscode.ipynb')
        this.vscodeIpynbApi = await ext?.activate()

        const fricasVersions =
            await this.fricasExecutableFeature.getFriCASExePathsAsync()

        for (const fricasVersion of fricasVersions) {
            const ver = fricasVersion.getVersion()
            const kernelId = fricasVersion.channel
                ? `fricas-vscode-${fricasVersion.channel}`
                : `fricas-vscode-${ver}`
            const displayName = fricasVersion.channel
                ? `FriCAS ${fricasVersion.channel} channel`
                : `FriCAS ${ver}`

            const controller = vscode.notebooks.createNotebookController(
                kernelId,
                JupyterNotebookViewType,
                displayName
            )
            controller.supportedLanguages = ['fricas']
            controller.supportsExecutionOrder = true
            controller.description = 'FriCAS VS Code extension'
            controller.detail = fricasVersion.getCommand()
            controller.onDidChangeSelectedNotebooks((e) => {
                if (e.selected && e.notebook) {
                    e.notebook
                        .getCells()
                        .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
                        .map((cell) =>
                            vscode.languages.setTextDocumentLanguage(cell.document, 'fricas')
                        )
                }
            })
            controller.executeHandler = this.executeCells.bind(this)
            controller.interruptHandler = this.interrupt.bind(this)
            controller.onDidChangeSelectedNotebooks(
                ({ notebook, selected }) => {
                    // If we select our controller, then update the notebook metadata with the kernel information.
                    if (!selected) {
                        return
                    }
                    this.updateNotebookWithSelectedKernel(notebook, ver)
                },
                this,
                this.disposables
            )

            this._controllers.set(controller, fricasVersion)
        }
    }

    private onDidOpenNotebookDocument(e: vscode.NotebookDocument) {
        if (!this.isFriCASNotebook(e) || this._controllers.size === 0) {
            return
        }
        // Get metadata from notebook (to get an hint of what version of fricas is used)
        const version = this.getNotebookLanguageVersion(e)

        // Find all controllers where the FriCAS version matches the FriCAS version in the
        // notebook exactly. If there are multiple controllers, put official release first,
        // and prefer x64 builds
        const perfectMatchVersions = Array.from(this._controllers.entries())
            .filter(
                ([_, fricasExec]) => fricasExec.getVersion().toString() === semver.parse(version).toString()
            )
            .sort(([_, a], [__, b]) => {
                // First, we give preference to official releases, rather than linked fricasup channels
                if (a.officialChannel !== b.officialChannel) {
                    return a.officialChannel ? -1 : 1
                }
                // Next we give preference to x64 builds
                else if (a.arch !== b.arch) {

                    if (a.arch === 'x64') {
                        return -1
                    } else if (b.arch === 'x64') {
                        return 1
                    } else {
                        return 0
                    }
                }
                // Then we give preference to release and lts channels
                else if (a.channel==='release' || a.channel.startsWith('release~')) {
                    return -1
                }
                else if (b.channel==='release' || b.channel.startsWith('release~')) {
                    return 1
                } else if (a.channel==='lts' || a.channel.startsWith('lts~')) {
                    return -1
                }
                else if (b.channel==='lts' || b.channel.startsWith('lts~')) {
                    return 1
                }
                else {
                    return 0
                }
            })

        if (perfectMatchVersions.length > 0) {
            const [controller, _] = perfectMatchVersions[0]

            controller.updateNotebookAffinity(
                e,
                vscode.NotebookControllerAffinity.Preferred
            )
        } else {
            // Find all controllers where the major and minor version match. Put newer patch versions first,
            // and then have the same preference ordering that we had above
            const minorMatchVersions = Array.from(this._controllers.entries())
                .filter(([_, fricasExec]) => {
                    const v1 = fricasExec.getVersion()
                    const v2 = semver.parse(version)
                    return v1.major === v2.major && v1.minor === v2.minor
                })
                .sort(([_, a], [__, b]) => {
                    const aVer = a.getVersion()
                    const bVer = b.getVersion()
                    if (aVer.patch !== bVer.patch) {
                        return b.getVersion().patch - a.getVersion().patch
                    } else if (a.officialChannel !== b.officialChannel) {
                        // First, we give preference to official releases, rather than linked fricasup channels
                        return a.officialChannel ? -1 : 1
                    } else if (a.arch !== b.arch) {
                        // Next we give preference to x64 builds
                        if (a.arch === 'x64') {
                            return -1
                        } else if (b.arch === 'x64') {
                            return 1
                        } else {
                            return 0
                        }
                    } else {
                        return 0
                    }
                })

            if (minorMatchVersions.length > 0) {
                const [controller, _] = minorMatchVersions[0]

                controller.updateNotebookAffinity(
                    e,
                    vscode.NotebookControllerAffinity.Preferred
                )
            }
        }
    }

    private async executeCells(
        cells: vscode.NotebookCell[],
        notebook: vscode.NotebookDocument,
        controller: vscode.NotebookController
    ): Promise<void> {
        // First check whether we already have a kernel running for the current notebook document
        if (!this.kernels.has(notebook)) {
            // Check whether there is still a running kernel for a closed notebook with the same Uri
            let foundExistingKernel = false
            for (const [k, v] of this.kernels) {
                if (k.isClosed && k.uri.toString() === notebook.uri.toString()) {
                    foundExistingKernel = true
                    v.notebook = notebook

                    this.kernels.delete(k)

                    this.kernels.set(notebook, v)

                    break
                }
            }

            if (!foundExistingKernel) {
                await this.startKernel(notebook, controller)
            }
        }

        const currentKernel = this.kernels.get(notebook)

        for (const cell of cells) {
            await currentKernel.queueCell(cell)
        }
    }

    private async interrupt(notebook: vscode.NotebookDocument) {
        this.kernels.forEach((kernel, document) => {
            if (document.uri.toString() === notebook.uri.toString()) {
                kernel.interrupt()
                return
            }
        })
    }

    private getNotebookLanguageVersion(
        notebook: vscode.NotebookDocument
    ): string {
        const metadata = (notebook.metadata as JupyterNotebookMetadata)?.custom
            .metadata
        const version = metadata?.language_info?.version || ''
        return this.isFriCASNotebook(notebook) ? version : ''
    }

    private updateNotebookWithSelectedKernel(
        notebook: vscode.NotebookDocument,
        version: semver.SemVer
    ) {
        const metadata = {
            kernelspec: {
                display_name: `FriCAS ${version}`,
                language: 'fricas',
                name: `fricas-${version.major}.${version.minor}`,
            },
            language_info: {
                name: 'fricas',
                version: `${version}`,
                mimetype: 'application/fricas',
                file_extension: '.spad',
            },
        }

        if (this.vscodeIpynbApi) {
            this.vscodeIpynbApi.setNotebookMetadata(notebook.uri, metadata)
        }
    }

    private isFriCASNotebook(notebook: vscode.NotebookDocument) {
        if (notebook.notebookType !== JupyterNotebookViewType) {
            return false
        }

        return (
            (
                notebook.metadata as JupyterNotebookMetadata
            )?.custom.metadata?.language_info?.name?.toLocaleLowerCase() === 'fricas'
        )
    }

    async startKernel(
        notebook: vscode.NotebookDocument,
        controller: vscode.NotebookController
    ) {
        const kernel = new FriCASKernel(
            this.context.extensionPath,
            controller,
            notebook,
            this._controllers.get(controller),
            this._outputChannel,
            this
        )
        await this.workspaceFeature.addNotebookKernel(kernel)
        this.kernels.set(notebook, kernel)

        kernel.onStopped((e) => {
            if (this.kernels.get(kernel.notebook) === kernel) {
                this.kernels.delete(kernel.notebook)
            }
        })
        return kernel
    }

    public async restart(kernel: FriCASKernel) {
        await kernel.stop()
        await this.startKernel(kernel.notebook, kernel.controller)
    }

    async stopKernel(
        node: NotebookNode | { notebookEditor: { notebookUri: vscode.Uri } }
    ) {
        if (node instanceof NotebookNode) {
            node.stop()
        } else {
            const uri = node.notebookEditor.notebookUri
            this.kernels.forEach((kernel, document) => {
                if (document.uri.toString() === uri.toString()) {
                    kernel.stop()
                    return
                }
            })
        }
    }

    async restartKernel(
        node: NotebookNode | { notebookEditor: { notebookUri: vscode.Uri } }
    ) {
        if (node instanceof NotebookNode) {
            node.restart()
        } else {
            const uri = node.notebookEditor.notebookUri
            this.kernels.forEach((kernel, document) => {
                if (document.uri.toString() === uri.toString()) {
                    kernel.restart()
                    return
                }
            })
        }
    }

    public dispose() {
        this.kernels.forEach((i) => i.dispose())
        this.disposables.forEach((i) => i.dispose())
        this._controllers.forEach((_, i) => i.dispose())
        this._outputChannel.dispose()
    }
}

import * as vscode from 'vscode'
import * as rpc from 'vscode-jsonrpc/node'
import { onExit, onFinishEval, onInit } from '../interactive/repl'
import { setContext, wrapCrashReporting } from '../utils'

interface DebugConfigTreeItem {
    label: string
    hasChildren?: boolean
    fricasAccessor?: string
    isCompiledTree: boolean
}

const requestTypeGetDebugItems = new rpc.RequestType<
    { fricasAccessor: string },
    DebugConfigTreeItem[],
    void>('repl/getDebugItems')

export class DebugConfigTreeProvider implements vscode.TreeDataProvider<DebugConfigTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DebugConfigTreeItem | undefined> = new vscode.EventEmitter<DebugConfigTreeItem | undefined>()
    readonly onDidChangeTreeData: vscode.Event<DebugConfigTreeItem | undefined> = this._onDidChangeTreeData.event
    private _onDidChangeCompiledMode: vscode.EventEmitter<Boolean> = new vscode.EventEmitter<Boolean>()
    readonly onDidChangeCompiledMode: vscode.Event<Boolean> = this._onDidChangeCompiledMode.event
    private _compiledItems: Set<string> = new Set()
    public compiledMode = false
    private _connection = null

    refresh(el = null): void {
        this._onDidChangeTreeData.fire(el)
    }

    setConnection(conn) {
        this._connection = conn
    }

    getChildren(node?: DebugConfigTreeItem): vscode.ProviderResult<DebugConfigTreeItem[]> {
        if (node) {
            if (!node.isCompiledTree && node.hasChildren) {
                if (this._connection) {
                    const accessor = node.fricasAccessor
                    return Promise.race([
                        this._connection.sendRequest(requestTypeGetDebugItems, { fricasAccessor: accessor }),
                        new Promise(resolve => {
                            setTimeout(() => resolve([]), 10000)
                        })
                    ])
                }
                return []
            } else if (node.isCompiledTree && node.hasChildren) {
                return this.getCompiledTreeChildrenForNode(node)
            } else {
                return []
            }
        }
        return this.getToplevelItems()
    }

    getToplevelItems(): DebugConfigTreeItem[] {
        return [
            {
                label: 'Compiled',
                hasChildren: true,
                fricasAccessor: '#root-compiled',
                isCompiledTree: true
            },
            {
                label: 'All',
                hasChildren: true,
                fricasAccessor: '#root',
                isCompiledTree: false
            }
        ]
    }

    getCompiledTreeChildrenForNode(node: DebugConfigTreeItem) {
        const out: DebugConfigTreeItem[] = []
        for (let item of [...this._compiledItems]) {
            const isRoot = node.fricasAccessor.startsWith('#root')
            const isNegative = item.startsWith('-') && item.length > 1
            if (isNegative) {
                item = item.slice(1, item.length)
            }
            if (item.startsWith(node.fricasAccessor) || isRoot) {
                const rest = item.slice(node.fricasAccessor.length)
                const parts = (isRoot ? item : rest).split('.').filter(x => x.length > 0)
                if (parts.length > 0) {
                    const fricasAccessor = isRoot ?
                        parts[0] :
                        item.slice(0, node.fricasAccessor.length - (node.fricasAccessor.endsWith('.') ? 1 : 0)) + '.' + parts[0]
                    const index = out.map(x => x.fricasAccessor).indexOf(fricasAccessor)
                    if (index === -1) {
                        out.push({
                            label: parts[0],
                            hasChildren: parts.length > 1,
                            fricasAccessor: fricasAccessor,
                            isCompiledTree: true
                        })
                    } else {
                        out[index].hasChildren = true
                    }
                }
            }
        }
        return [...out].sort((a, b) => a.label.localeCompare(b.label))
    }

    getTreeItem(node: DebugConfigTreeItem): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(node.label)
        const id = this.getNodeId(node)
        const parent = <DebugConfigTreeItem | undefined>this.getParent(node)
        let anyAncestorCompiledAll = false

        // this is bad and I feel bad
        let p = node
        while (true) {
            p = <DebugConfigTreeItem | undefined>this.getParent(p)
            if (p === undefined || !p.fricasAccessor) {
                break
            }
            if (this._compiledItems.has(this.getNodeId(p) + '.')) {
                anyAncestorCompiledAll = true
                break
            }
        }
        const compiledBecauseParentIsCompiled = node.hasChildren ? parent && this._compiledItems.has(this.getNodeId(parent) + '.') : parent && this._compiledItems.has(this.getNodeId(parent))
        const isCompiledAll = this._compiledItems.has(id + '.') || (anyAncestorCompiledAll && node.hasChildren)
        const isCompiled = (this._compiledItems.has(id) || compiledBecauseParentIsCompiled || anyAncestorCompiledAll || isCompiledAll) && !this._compiledItems.has('-' + id)
        if (!id.startsWith('#')) {
            treeItem.description = isCompiled ? 'compiled' + (isCompiledAll ? ' (all)' : '') : 'interpreted'
            treeItem.tooltip = isCompiled ? 'Compiled code cannot be stepped through and breakpoints are disregarded.' : 'Interpreted code can be stepped through and breakpoints are respected.'
            treeItem.contextValue = ''
            if (compiledBecauseParentIsCompiled || anyAncestorCompiledAll) {
                treeItem.contextValue += 'parentCompiled '
            }
            if (isCompiled) {
                treeItem.contextValue += 'compiled '
            } else {
                treeItem.contextValue += 'interpreted '
            }
            if (node.hasChildren) {
                treeItem.contextValue += 'hasChildren '
            }
        } else if (id === '#root-compiled') {
            treeItem.contextValue = 'isRootCompiled'
        }
        treeItem.collapsibleState = node.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        // treeItem.id = id
        return treeItem
    }

    getParent(node: DebugConfigTreeItem): vscode.ProviderResult<DebugConfigTreeItem> {
        if (node.fricasAccessor === undefined) {
            return
        } else {
            const path = node.fricasAccessor
            const parts = path.split('.')
            parts.pop()
            if (parts.length === 0) {
                return
            } else {
                return {
                    label: parts[parts.length - 1], // previous name
                    hasChildren: true, // by definition
                    fricasAccessor: parts.join('.'),
                    isCompiledTree: node.isCompiledTree
                }
            }
        }
    }

    switchStatus(node: DebugConfigTreeItem, compiled: boolean, all: boolean = false) {
        if (node === undefined) {
            console.error('switchStatus called with undefined!')
            return
        }
        const id = this.getNodeId(node)
        if (compiled) {
            if (all) {
                this._compiledItems.add(id + '.')
            }
            const removed = this._compiledItems.delete('-' + id)
            if (!removed) {
                this._compiledItems.add(id)
            }
        } else {
            let removed = this._compiledItems.delete(id)
            removed = this._compiledItems.delete(id + '.') || removed
            if (!removed) {
                this._compiledItems.add('-' + id)
            }
        }
        this.refresh()
    }

    getNodeId(node: DebugConfigTreeItem): string {
        return node.fricasAccessor
    }

    getCompiledItems() {
        return [...this._compiledItems]
    }

    applyDefaults() {
        this.reset()

        //const defaults: string[] = vscode.workspace.getConfiguration('fricas').get('debuggerDefaultCompiled')
        //defaults.forEach(el => this._compiledItems.add(el))
        this.refresh()
    }

    setCurrentAsDefault() {
        //vscode.workspace.getConfiguration('fricas').update('debuggerDefaultCompiled', this.getCompiledItems(), true)
    }

    addNameToCompiled(name: string) {
        this._compiledItems.add(name)
        this.refresh()
    }

    enableCompiledMode() {
        this.compiledMode = true
        this._onDidChangeCompiledMode.fire(this.compiledMode)
    }

    disableCompiledMode() {
        this.compiledMode = false
        this._onDidChangeCompiledMode.fire(this.compiledMode)
    }

    reset() {
        this._compiledItems.clear()
        this.refresh()
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new DebugConfigTreeProvider()
    provider.applyDefaults()
    setContext('fricas.debuggerCompiledMode', false)

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('fricas-debugger-compiled', provider),
        vscode.commands.registerCommand('language-fricas.switchToCompiled', (item: DebugConfigTreeItem) => {
            provider.switchStatus(item, true, false)
        }),
        vscode.commands.registerCommand('language-fricas.switchToInterpreted', (item: DebugConfigTreeItem) => {
            provider.switchStatus(item, false, false)
        }),
        vscode.commands.registerCommand('language-fricas.switchAllToCompiled', (item: DebugConfigTreeItem) => {
            provider.switchStatus(item, true, true)
        }),
        vscode.commands.registerCommand('language-fricas.switchAllToInterpreted', (item: DebugConfigTreeItem) => {
            provider.switchStatus(item, false, true)
        }),
        vscode.commands.registerCommand('language-fricas.refreshCompiled', () => {
            provider.refresh()
        }),
        vscode.commands.registerCommand('language-fricas.apply-compiled-defaults', () => {
            provider.applyDefaults()
        }),
        vscode.commands.registerCommand('language-fricas.reset-compiled', () => {
            provider.reset()
        }),
        vscode.commands.registerCommand('language-fricas.set-compiled-for-name', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Please enter a fully qualified module or function name you want the debugger to treat as compiled code (e.g. `Base.Math.sin` or `StaticArrays`). A trailing `.` will treat all submodules as compiled as well. A prefixed `-` will ensure that all methods of the specified function are always interpreted.'
            })
            if (name) {
                provider.addNameToCompiled(name)
            }
        }),
        vscode.commands.registerCommand('language-fricas.set-current-as-default-compiled', async () => {
            provider.setCurrentAsDefault()
        }),
        vscode.commands.registerCommand('language-fricas.enable-compiled-mode', async () => {
            provider.enableCompiledMode()
            setContext('fricas.debuggerCompiledMode', true)
        }),
        vscode.commands.registerCommand('language-fricas.disable-compiled-mode', async () => {
            provider.disableCompiledMode()
            setContext('fricas.debuggerCompiledMode', false)
        }),
        onInit(wrapCrashReporting(connection => {
            provider.setConnection(connection)
            provider.refresh()
        })),
        onFinishEval(_ => provider.refresh()),
        onExit(e => {
            provider.setConnection(null)
            provider.refresh()
        }),
    )
    return provider
}

export function deactivate() { }

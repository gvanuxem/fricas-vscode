'use strict'
import * as sourcemapsupport from 'source-map-support'
import * as fs from 'async-file'
import { unwatchFile, watchFile } from 'async-file'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions} from 'vscode-languageclient/node'
//import * as debugViewProvider from './debugger/debugConfig'
//import { FriCASDebugFeature } from './debugger/debugFeature'
import * as documentation from './docbrowser/documentation'
//import { ProfilerFeature } from './interactive/profiler'
import { FriCASDocumentSymbolProvider } from './outline'
import * as repl from './interactive/repl'
import { WorkspaceFeature } from './interactive/workspace'
import * as spadpkgenv from './spadpkgenv'
import { FriCASExecutablesFeature } from './fricasexepath'
//import { FriCASNotebookFeature } from './notebook/notebookFeature'
import * as smallcommands from './smallcommands'
import * as tasks from './tasks'
import { registerCommand, setContext } from './utils'
import { FriCASGlobalDiagnosticOutputFeature } from './globalDiagnosticOutput'

sourcemapsupport.install({ handleUncaughtExceptions: false })

let g_languageClient: LanguageClient = null
let g_context: vscode.ExtensionContext = null
let g_watchedEnvironmentFile: string = null
let g_startupNotification: vscode.StatusBarItem = null
let g_fricasExecutablesFeature: FriCASExecutablesFeature = null

let g_traceOutputChannel: vscode.OutputChannel = null
let g_outputChannel: vscode.OutputChannel = null

export const increaseIndentPattern: RegExp = /^(\s*|.*=\s*|.*@\w*\s*)[\w\s]*(?:["'`][^"'`]*["'`])*[\w\s]*\b(if|while|.*\)\s*do|else|else\s+if)\b(?!(?:.*\bend\b(\s*|\s*#.*)$)|(?:[^\[]*\].*)$).*$/
export const decreaseIndentPattern: RegExp = /^\s*(else|else\s+if)\b.*$/

export async function activate(context: vscode.ExtensionContext) {
    try {
        setContext('fricas.isActive', true)

        //telemetry.traceEvent('activate')

        //telemetry.startLsCrashServer()

        g_context = context
        console.debug('Activating extension language-fricas')
        const globalDiagnosticOutputFeature = new FriCASGlobalDiagnosticOutputFeature()
        context.subscriptions.push(globalDiagnosticOutputFeature)

        // Config change
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(changeConfig))

        // Language settings
        vscode.languages.setLanguageConfiguration('fricas', {
            indentationRules: {
                increaseIndentPattern: increaseIndentPattern,
                decreaseIndentPattern: decreaseIndentPattern
            }
        })
        const SymbolProvider = new FriCASDocumentSymbolProvider()
        context.subscriptions.push(
            vscode.languages.registerDocumentSymbolProvider(
                {scheme: "file", language: "fricas"},
                SymbolProvider
            )
        );
        //const profilerFeature = new ProfilerFeature(context)
        //context.subscriptions.push(profilerFeature)

        // Active features from other files
        //const compiledProvider = debugViewProvider.activate(context)
        g_fricasExecutablesFeature = new FriCASExecutablesFeature(context, globalDiagnosticOutputFeature)
        context.subscriptions.push(g_fricasExecutablesFeature)
        await g_fricasExecutablesFeature.getActiveFriCASExecutableAsync() // We run this function now and await to make sure we don't run in twice simultaneously later

        repl.activate(context, g_fricasExecutablesFeature)
        documentation.activate(context)
        tasks.activate(context, g_fricasExecutablesFeature)
        smallcommands.activate(context)
        spadpkgenv.activate(context, g_fricasExecutablesFeature)

        const workspaceFeature = new WorkspaceFeature(context)
        context.subscriptions.push(workspaceFeature)
        //context.subscriptions.push(new FriCASNotebookFeature(context, g_fricasExecutablesFeature, workspaceFeature))
        //context.subscriptions.push(new FriCASDebugFeature(context, compiledProvider, g_fricasExecutablesFeature))
        //g_testFeature = new TestFeature(context, g_fricasExecutablesFeature, workspaceFeature)
        //context.subscriptions.push(g_testFeature)

        g_startupNotification = vscode.window.createStatusBarItem()
        context.subscriptions.push(g_startupNotification)

        context.subscriptions.push(registerCommand('language-fricas.showLanguageServerOutput', () => {
            if (g_languageClient) {
                g_languageClient.outputChannel.show(true)
            }
        }))

        // Start language server
        startLanguageServer(g_fricasExecutablesFeature)
        context.subscriptions.push(
            // commands
            registerCommand('language-fricas.restartLanguageServer', restartLanguageServer)
        )

        const api = {
            version: 4,
            async getFriCASExecutable() {
                return await g_fricasExecutablesFeature.getActiveFriCASExecutableAsync()
            },
            async getFriCASPath() {
                console.warn('FriCAS extension for VSCode: `getFriCASPath` API is deprecated.')
                return (await g_fricasExecutablesFeature.getActiveFriCASExecutableAsync()).file
            },
            executeInREPL: repl.executeInREPL
        }

        return api
    }
    catch (err) {
        throw (err)
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    const promises = []

    promises.push(repl.deactivate())

    if (g_languageClient) {
        promises.push(g_languageClient.stop())
    }

    return Promise.all(promises)
}

const g_onSetLanguageClient = new vscode.EventEmitter<LanguageClient>()
export const onSetLanguageClient = g_onSetLanguageClient.event
function setLanguageClient(languageClient: LanguageClient = null) {
    g_onSetLanguageClient.fire(languageClient)
    g_languageClient = languageClient
}

export async function withLanguageClient(
    callback: (languageClient: LanguageClient) => any,
    callbackOnHandledErr: (err: Error) => any
) {
    if (g_languageClient === null) {
        return callbackOnHandledErr(new Error('Language client is not active'))
    }

    try {
        return callback(g_languageClient)
    } catch (err) {
        if (err.message === 'Language client is not ready yet') {
            return callbackOnHandledErr(err)
        }
        throw err
    }
}

const g_onDidChangeConfig = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>()
export const onDidChangeConfig = g_onDidChangeConfig.event
function changeConfig(event: vscode.ConfigurationChangeEvent) {
    g_onDidChangeConfig.fire(event)
    if (event.affectsConfiguration('fricas.executablePath')) {
        restartLanguageServer()
    }
}

const supportedSchemes = [
    'file',
    'untitled',
    'vscode-notebook-cell'
]

const supportedLanguages = [
    'fricas',
    'markdown'
]

async function startLanguageServer(fricasExecutablesFeature: FriCASExecutablesFeature) {
    g_startupNotification.text = 'FriCAS: Starting Language Server…'
    g_startupNotification.show()

    const storagePath = g_context.globalStorageUri.fsPath

    const languageServerDepotPath = path.join(storagePath, 'lsdepot', 'v1')
    await fs.createDirectory(languageServerDepotPath)
    const serverArgsRun: string[] = []
    //['--startup-file=no', '--history-file=no', '--depwarn=no', 'main.jl', fricasEnvPath, '--debug=no', telemetry.getCrashReportingPipename(), oldDepotPath, storagePath, useSymserverDownloads, symserverUpstream, '--detached=no']
    const serverArgsDebug: string[] = ['-nosman', '-eval \')set break break\'']
    //['--startup-file=no', '--history-file=no', '--depwarn=no', 'main.jl', fricasEnvPath, '--debug=yes', telemetry.getCrashReportingPipename(), oldDepotPath, storagePath, useSymserverDownloads, symserverUpstream, '--detached=no']
    const spawnOptions = {
        cwd: process.env.HOME ? process.env.HOME : os.homedir(),
	//path.join(g_context.extensionPath, 'scripts', 'languageserver'),
        env: {
            //FRICAS: ''
            FRICAS_DEPOT_PATH: languageServerDepotPath,
            FRICAS_LOAD_PATH: process.platform === 'win32' ? ';' : ':',
            HOME: process.env.HOME ? process.env.HOME : os.homedir(),
            FRICAS_LANGUAGESERVER: '1',
            PATH: process.env.PATH
        }
    }

    let fricasExecutable = await fricasExecutablesFeature.getActiveFriCASExecutableAsync()

    if (fricasExecutable === undefined) {
        vscode.window.showErrorMessage(
            '[2] Could not start the FriCAS language server. Make sure the `fricas.executablePath` setting points to the FriCAS binary.',
            'Open Settings'
        ).then(val => {
            if (val) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'fricas.executablePath')
            }
        })
        g_startupNotification.hide()
        return
    }
    const serverOptions: ServerOptions = Boolean(process.env.DETACHED_LS) ?
        async () => {
            // TODO Add some loop here that retries in case the LSP is not yet ready
            const conn = net.connect(7777)
            return { reader: conn, writer: conn, detached: true }
        } :
        {
            run: { command: fricasExecutable.file, args: [...fricasExecutable.args, ...serverArgsRun], options: spawnOptions },
            debug: { command: fricasExecutable.file, args: [...fricasExecutable.args, ...serverArgsDebug], options: spawnOptions }
        }

    const selector = []
    for (const scheme of supportedSchemes) {
        for (const language of supportedLanguages) {
            selector.push({
                language,
                scheme
            })
        }
    }

    if (!g_outputChannel) {
        g_outputChannel = vscode.window.createOutputChannel('FriCAS Language Server')
    }
    if (!g_traceOutputChannel) {
        g_traceOutputChannel = vscode.window.createOutputChannel('FriCAS Language Server Trace')
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector: selector,
        synchronize: {
            fileEvents: [
                vscode.workspace.createFileSystemWatcher('**/*.{spad,input}')
                //vscode.workspace.createFileSystemWatcher('**/{Project.toml,FriCASProject.toml,Manifest.toml,FriCASManifest.toml}'),
            ]
        },
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        traceOutputChannel: g_traceOutputChannel,
        outputChannel: g_outputChannel,
        initializationOptions: {fricaslangTestItemIdentification: true},
    }

    // Create the language client and start the client.
    const languageClient = new LanguageClient('fricas', 'FriCAS Language Server', serverOptions, clientOptions)
    languageClient.registerProposedFeatures()

    if (g_watchedEnvironmentFile) {
        unwatchFile(g_watchedEnvironmentFile)
    }

    // automatic environement refreshing
    //g_watchedEnvironmentFile = (await spadpkgenv.getProjectFilePaths(fricasEnvPath)).manifest_toml_path
    // polling watch for robustness
    if (g_watchedEnvironmentFile) {
        watchFile(g_watchedEnvironmentFile, { interval: 10000 }, async (curr, prev) => {
            if (curr.mtime > prev.mtime) {
                if (!languageClient.needsStop()) { return } // this client already gets stopped
                await refreshLanguageServer(languageClient)
            }
        })
    }

    try {
        g_startupNotification.command = 'language-fricas.showLanguageServerOutput'
        setLanguageClient(languageClient)
        await languageClient.start()
    }
    catch (e) {
        vscode.window.showErrorMessage('[3] Could not start the FriCAS language server. Make sure the configuration setting fricas.executablePath points to the FriCAS binary.', 'Open Settings').then(val => {
            if (val) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'fricas.executablePath')
            }
        })
        setLanguageClient()
    }
    g_startupNotification.hide()
}

async function refreshLanguageServer(languageClient: LanguageClient = g_languageClient) {
    if (!languageClient) { return }
    try {
        await languageClient.sendNotification('fricas/refreshLanguageServer')
    } catch (err) {
        vscode.window.showErrorMessage('Failed to refresh the language server cache.', {
            detail: err
        })
    }
}

async function restartLanguageServer(languageClient: LanguageClient = g_languageClient) {
    if (languageClient !== null) {
        await languageClient.stop()
        setLanguageClient()
    }
    await startLanguageServer(g_fricasExecutablesFeature)
}

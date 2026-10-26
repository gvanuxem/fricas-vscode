import * as fs from 'async-file'
import * as os from 'os'
import * as path from 'path'
//import { execFile } from 'promisify-child-process'
import * as vscode from 'vscode'
import * as vslc from 'vscode-languageclient/node'
import { onSetLanguageClient } from './extension'
import { FriCASExecutablesFeature } from './fricasexepath'
import { registerCommand, resolvePath } from './utils'

let g_languageClient: vslc.LanguageClient = null

let g_current_environment: vscode.StatusBarItem = null

let g_path_of_current_environment: string = null
let g_path_of_default_environment: string = null
//let g_resolved_path_of_environment: string = null

//let g_fricasExecutablesFeature: FriCASExecutablesFeature = null

export async function getProjectFilePaths(envpath: string) {
    return {
        project_toml_path: (await fs.exists(path.join(envpath, 'FriCASProject.toml'))) ?
            path.join(envpath, 'FriCASProject.toml') :
            (await fs.exists(path.join(envpath, 'Project.toml'))) ? path.join(envpath, 'Project.toml') : undefined,
        manifest_toml_path: (await fs.exists(path.join(envpath, 'FriCASManifest.toml'))) ?
            path.join(envpath, 'FriCASManifest.toml') :
            (await fs.exists(path.join(envpath, 'Manifest.toml'))) ? path.join(envpath, 'Manifest.toml') : undefined,
    }
}

export async function switchEnvToPath(envpath: string, notifyLS: boolean) {
    g_path_of_current_environment = envpath
    //g_resolved_path_of_environment = resolvePath(envpath)

    const section = vscode.workspace.getConfiguration('fricas')

    const currentConfigValue = section.get<string>('environmentPath')

    if (g_path_of_current_environment !== await getDefaultEnvPath()) {
        if (currentConfigValue !== g_path_of_current_environment) {
            section.update('environmentPath', g_path_of_current_environment, vscode.ConfigurationTarget.Workspace)
        }
    }
    else {
        if (currentConfigValue !== null) {
            section.update('environmentPath', undefined, vscode.ConfigurationTarget.Workspace)
        }
    }

    g_current_environment.text = 'FriCAS env: ' + await getEnvName()

    if (notifyLS) {
        if (!g_languageClient) {
            return
        }
        await g_languageClient.sendNotification('fricas/activateenvironment', { envPath: envpath })
    }
}

async function changeFriCASEnvironment() {

    const optionsEnv: vscode.QuickPickOptions = {
        placeHolder: 'Select FriCAS working environment / directory'
    }

    const envFolders: { label: string, description: string }[] = [{ label: '$(folder) (pick a folder)', description: '' }]

    if (vscode.workspace.workspaceFolders) {
        for (const workspaceFolder of vscode.workspace.workspaceFolders) {
            envFolders.push({ label: `$(root-folder) ${workspaceFolder.name}`, description: workspaceFolder.uri.fsPath })
        }
    }

    const resultPackage = await vscode.window.showQuickPick(envFolders, optionsEnv)

    if (resultPackage !== undefined) {
        if (resultPackage.description === '') {
            const resultFolder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true })
            if (resultFolder && resultFolder.length > 0) {
                const envPath = resultFolder[0].fsPath
                switchEnvToPath(envPath, true)
            }
        }
        else {
            switchEnvToPath(resultPackage.description, true)
        }
    }
}

async function getDefaultEnvPath() {
    if (g_path_of_default_environment === null) {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            g_path_of_default_environment = vscode.workspace.workspaceFolders[0].uri.fsPath
        } else {
            g_path_of_default_environment = os.homedir()
        }
    }
    return g_path_of_default_environment
}

async function getEnvPath() {
    if (g_path_of_current_environment === null) {
        const section = vscode.workspace.getConfiguration('fricas')
        const envPathConfig = section.get<string>('environmentPath')
        if (envPathConfig) {
            if (await fs.exists(absEnvPath(resolvePath(envPathConfig)))) {
                g_path_of_current_environment = envPathConfig
                return g_path_of_current_environment
            }
        }
        g_path_of_current_environment = await getDefaultEnvPath()
    }
    return g_path_of_current_environment
}

function absEnvPath(p: string) {
    if (path.isAbsolute(p)) {
        return p
    } else {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, p)
        } else {
            return path.join(os.homedir(), p)
        }
    }
}

export async function getAbsEnvPath() {
    const envPath = await getEnvPath()
    return absEnvPath(resolvePath(envPath))
}

export async function getEnvName() {
    const envpath = resolvePath(await getEnvPath())
    return path.basename(envpath)
}

export async function activate(context: vscode.ExtensionContext, fricasExecutablesFeature: FriCASExecutablesFeature) {
    //g_fricasExecutablesFeature = fricasExecutablesFeature
    context.subscriptions.push(onSetLanguageClient(languageClient => {
        g_languageClient = languageClient
    }))

    context.subscriptions.push(registerCommand('language-fricas.changeCurrentEnvironment', changeFriCASEnvironment))
    // Environment status bar
    g_current_environment = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
    g_current_environment.show()
    g_current_environment.tooltip = 'Choose FriCAS environment'
    g_current_environment.text = 'FriCAS env: [loading]'
    g_current_environment.command = 'language-fricas.changeCurrentEnvironment'
    context.subscriptions.push(g_current_environment)
    await switchEnvToPath(await getEnvPath(), false) // We don't need to notify the LS here because it will start with that env already
}

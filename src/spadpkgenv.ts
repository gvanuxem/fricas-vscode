import * as fs from 'async-file'
import * as os from 'os'
import * as path from 'path'
//import { execFile } from 'promisify-child-process'
import * as vscode from 'vscode'
import * as vslc from 'vscode-languageclient/node'
import { onSetLanguageClient } from './extension'
import { FriCASExecutablesFeature } from './fricasexepath'
import * as telemetry from './telemetry'
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
    telemetry.traceEvent('changeCurrentEnvironment')

    const optionsEnv: vscode.QuickPickOptions = {
        placeHolder: 'Select environment'
    }

    const projectNames = ['FriCASProject.toml', 'Project.toml']
    const homeDir = os.homedir()

    const envFolders = [{ label: '(pick a folder)', description: '' }]

    if (vscode.workspace.workspaceFolders) {
        for (const workspaceFolder of vscode.workspace.workspaceFolders) {
            let curPath = workspaceFolder.uri.fsPath.toString()
            while (true) {
                const oldPath = curPath
                for (const projectName of projectNames) {
                    if (await fs.exists(path.join(curPath, projectName))) {
                        envFolders.push({ label: path.basename(curPath), description: curPath })
                        break
                    }
                }
                if (curPath === homeDir) { break }
                curPath = path.dirname(curPath)
                if (oldPath === curPath) { break }
            }
        }
    }

    const resultPackage = await vscode.window.showQuickPick(envFolders, optionsEnv)

    if (resultPackage !== undefined) {
        if (resultPackage.description === '') {
            const resultFolder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true })
            // Is this actually an environment?
            if (resultFolder !== undefined) {
                const envPathUri = resultFolder[0].toString()
                const envPath = vscode.Uri.parse(envPathUri).fsPath
                const isThisAEnv = await fs.exists(path.join(envPath, 'Project.toml'))
                if (isThisAEnv) {
                    switchEnvToPath(envPath, true)
                }
                else {
                    vscode.window.showErrorMessage('The selected path is not a fricas environment.')
                }
            }
        }
        else {
            switchEnvToPath(resultPackage.description, true)
        }
    }
}

async function getDefaultEnvPath() {
    if (g_path_of_default_environment === null) {
        if (vscode.workspace.workspaceFolders) {
            if (vscode.workspace.workspaceFolders.length === 1) {
                const projectFilePath1 = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'FriCASProject.toml')
                const manifestFilePath1 = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'FriCASManifest.toml')
                const projectFilePath2 = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Project.toml')
                const manifestFilePath2 = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Manifest.toml')
                if (await fs.exists(projectFilePath1) && await fs.exists(manifestFilePath1)) {
                    return vscode.workspace.workspaceFolders[0].uri.fsPath
                }
                else if (await fs.exists(projectFilePath2) && await fs.exists(manifestFilePath2)) {
                    return vscode.workspace.workspaceFolders[0].uri.fsPath
                }
            }
        }
        
        //const fricasExecutable = await g_fricasExecutablesFeature.getActiveFriCASExecutableAsync()
        /*const res = '/home/greg'/*await execFile(
            fricasExecutable.file,
            [
                '-eval', 'using Pkg; println(dirname(Pkg.Types.Context().env.project_file))'
            ])*/
        g_path_of_default_environment = '/home/greg' //res.stdout.toString().trim()
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

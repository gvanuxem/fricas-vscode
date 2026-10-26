import { exists } from 'async-file'
import * as os from 'os'
import * as path from 'path'
import * as process from 'process'
import { execFile } from 'promisify-child-process'
import { parse } from 'semver'
import stringArgv from 'string-argv'
import * as vscode from 'vscode'
import { onDidChangeConfig } from './extension'
import { FriCASGlobalDiagnosticOutputFeature } from './globalDiagnosticOutput'
import { resolvePath } from './utils'
//import { getEnvName } from './spadpkgenv'


export class FriCASExecutable {
    private _baseRootFolderPath: string | undefined

    constructor(public version: string, public file: string, public args: string[], public arch: string | undefined, public channel: string | undefined, public officialChannel: boolean) {
    }

    public getVersion() {
        return parse(this.version)
    }

    public async getBaseRootFolderPathAsync() {
        if (!this._baseRootFolderPath) {
            const fricasEnv = process.env.FRICAS
            if (fricasEnv && fricasEnv.trim().length > 0) {
                this._baseRootFolderPath = path.normalize(fricasEnv)
            } else if (this.file) {
                this._baseRootFolderPath = path.dirname(path.dirname(this.file))
            } else {
                this._baseRootFolderPath = os.homedir()
            }
        }

        return this._baseRootFolderPath
    }

    public getCommand() {
        // TODO Properly escape things
        return [this.file, ...this.args].join(' ')
    }
}

export class FriCASExecutablesFeature {
    private actualFriCASExePath: FriCASExecutable | undefined
    private cachedFriCASExePaths: FriCASExecutable[] | undefined

    constructor(private context: vscode.ExtensionContext, private diagnosticsOutput: FriCASGlobalDiagnosticOutputFeature) {
        this.context.subscriptions.push(
            onDidChangeConfig(event => {
                if (event.affectsConfiguration('fricas.executablePath')) {
                    this.actualFriCASExePath = undefined
                    this.cachedFriCASExePaths = undefined
                }
            })
        )
    }

    public dispose() {
    }

    async tryFriCASExePathAsync(newPath: string) {
        try {
            let parsedPath = ''
            let parsedArgs = ['-nosman']

            if (path.isAbsolute(newPath) && await exists(newPath)) {
                parsedPath = newPath
            }
            else {
                const resolvedPath = resolvePath(newPath, false)

                if (path.isAbsolute(resolvedPath) && await exists(resolvedPath)) {
                    parsedPath = resolvedPath
                }
                else {
                    const argv = stringArgv(newPath)

                    parsedPath = argv[0]
                    //parsedArgs = argv.slice(1)
                }
            }

            const { stdout, } = await execFile(parsedPath, ['--version'])

            const versionArrayFromFriCAS = stdout.toString().split('\n')
            //const versionArrayFromFriCAS = ['FriCAS 1.3.13-dev']
            const versionStringFromFriCAS = versionArrayFromFriCAS[0].trim()

            const versionPrefix = `FriCAS `
            if (!versionStringFromFriCAS.startsWith(versionPrefix)) {
                return undefined
            }

            return new FriCASExecutable(versionStringFromFriCAS.slice(versionPrefix.length), parsedPath, parsedArgs, undefined, undefined, true)
        }
        catch {
            return undefined
        }
    }

    async tryAndSetNewFriCASExePathAsync(newPath: string) {
        const newFriCASExecutable = await this.tryFriCASExePathAsync(newPath)

        if (newFriCASExecutable) {
            this.actualFriCASExePath = newFriCASExecutable
            return true
        }
        else {
            return false
        }
    }

    getSearchPaths(): string[] {
        const homedir = os.homedir()
        let pathsToSearch: string[] = []
        if (process.platform === 'win32') {
            pathsToSearch = [
                'fricas',
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS', 'bin', 'fricas.exe'),
                'C:\\fricas\\bin\\fricas.exe',
                'C:\\Program Files\\FriCAS\\bin\\fricas.exe',
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.4.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.3.11', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.3.10', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.3.9', 'bin', 'fricas.exe')
            ]
        }
        else if (process.platform === 'darwin') {
            pathsToSearch = [
                'fricas',
                '/usr/local/bin/fricas',
                '/opt/homebrew/bin/fricas',
                path.join(homedir, '.local', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas')
            ]
        }
        else {
            pathsToSearch = [
                'fricas',
                '/usr/local/bin/fricas',
                '/usr/bin/fricas',
                '/opt/fricas/bin/fricas',
                path.join(homedir, '.local', 'bin', 'fricas')
            ]
        }
        return pathsToSearch
    }

    public async getFriCASExePathsAsync(): Promise<FriCASExecutable[]> {
        if (!this.cachedFriCASExePaths) {
            const searchPaths = this.getSearchPaths()

            const executables: FriCASExecutable[] = []
            executables.push(await this.getActiveFriCASExecutableAsync())
            await Promise.all(searchPaths.map(async (filePath) => {
                const newFriCASExecutable = await this.tryFriCASExePathAsync(filePath)

                if (newFriCASExecutable) {
                    executables.push(newFriCASExecutable)
                }
            }))

            // Remove duplicates.
            this.cachedFriCASExePaths = executables.filter((v, i, a) => a.findIndex(t => (JSON.stringify(t) === JSON.stringify(v))) === i)

        }

        return this.cachedFriCASExePaths
    }

    public async getActiveFriCASExecutableAsync() {
        if (!this.actualFriCASExePath) {

            this.diagnosticsOutput.appendLine('Trying to locate FriCAS binary...')

            const configPath = this.getExecutablePath()
            if (!configPath) {
                for (const p of this.getSearchPaths()) {
                    if (await this.tryAndSetNewFriCASExePathAsync(p)) {
                        break
                    }
                }
            }
            else {
                await this.tryAndSetNewFriCASExePathAsync(configPath)
            }

            if(this.actualFriCASExePath) {
                this.diagnosticsOutput.appendLine(`The identified FriCAS executable is "${this.actualFriCASExePath.file}" version "${this.actualFriCASExePath.version}" with args "${this.actualFriCASExePath.args}".`)

            }
            else {
                this.diagnosticsOutput.appendLine(`No FriCAS executable was identified.`)
            }
            this.diagnosticsOutput.appendLine(`The current PATH environment variable is "${process.env.PATH}".`)
        }
        return this.actualFriCASExePath
    }

    getExecutablePath() {
        const fricasPath = vscode.workspace.getConfiguration('fricas').get<string>('executablePath')
        return fricasPath === '' ? '' : fricasPath
    }
}

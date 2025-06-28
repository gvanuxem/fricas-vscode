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
            this._baseRootFolderPath = path.normalize(process.env.FRICAS)
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
        let pathsToSearch = []
        if (process.platform === 'win32') {
            pathsToSearch = ['fricas',
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.9.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.9.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.8.5', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.8.4', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.8.3', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.8.2', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.8.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.8.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.7.3', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.7.2', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.7.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.7.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.8', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.7', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.6', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.5', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.4', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.3', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.2', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS-1.6.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS 1.5.4', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS 1.5.3', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS 1.5.2', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS 1.5.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS 1.5.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS', 'FriCAS-1.4.2', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS', 'FriCAS-1.4.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'Programs', 'FriCAS', 'FriCAS-1.4.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.3.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.3.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.2.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.1.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.1.0', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.0.5', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.0.4', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.0.3', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.0.2', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.0.1', 'bin', 'fricas.exe'),
                path.join(homedir, 'AppData', 'Local', 'FriCAS-1.0.0', 'bin', 'fricas.exe')
            ]
        }
        else if (process.platform === 'darwin') {
            pathsToSearch = ['fricas',
                path.join(homedir, 'Applications', 'FriCAS-1.9.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.9.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.8.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.8.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.7.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.7.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.6.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.6.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.5.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.5.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.4.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.4.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.3.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.3.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.2.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.2.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.1.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.1.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join(homedir, 'Applications', 'FriCAS-1.0.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas'),
                path.join('/', 'Applications', 'FriCAS-1.0.app', 'Contents', 'Resources', 'fricas', 'bin', 'fricas')]
        }
        else {
            pathsToSearch = ['fricas',
                path.join(homedir, '.local', 'bin', 'fricas'),
                path.join('/', 'usr', 'local', 'bin', 'fricas')]
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
        const jlpath = vscode.workspace.getConfiguration('fricas').get<string>('executablePath')
        return jlpath === '' ? '' : jlpath
    }
}

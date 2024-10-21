import * as fs from 'async-file'
import * as path from 'path'
import * as vscode from 'vscode'
import * as spadpkgenv from './spadpkgenv'
import { FriCASExecutablesFeature } from './fricasexepath'
import * as telemetry from './telemetry'
//import { inferFriCASNumThreads } from './utils'

class FriCASTaskProvider {
    constructor(private context: vscode.ExtensionContext, private fricasExecutablesFeature: FriCASExecutablesFeature) { }

    async provideTasks() {
        const emptyTasks: vscode.Task[] = []
        const allTasks: vscode.Task[] = []
        const folders = vscode.workspace.workspaceFolders

        if (!folders) {
            return emptyTasks
        }

        for (let i = 0; i < folders.length; i++) {
            const tasks = await this.provideFriCASTasksForFolder(folders[i])
            allTasks.push(...tasks)
        }
        return allTasks
    }

    async provideFriCASTasksForFolder(folder: vscode.WorkspaceFolder) {
        telemetry.traceEvent('task-provide')
        const emptyTasks: vscode.Task[] = []

        if (folder.uri.scheme !== 'file') {
            return emptyTasks
        }
        const rootPath = folder.uri.fsPath

        try {
            //const nthreads = inferFriCASNumThreads()
            const result: vscode.Task[] = []

            const fricasExecutable = await this.fricasExecutablesFeature.getActiveFriCASExecutableAsync()
            const pkgenvpath = await spadpkgenv.getAbsEnvPath()
            /*
            if (await fs.exists(path.join(rootPath, 'test', 'runtests.jl'))) {
                const jlargs = [
                    ...fricasExecutable.args,
                    '--color=yes',
                    `--project=${pkgenvpath}`,
                    '-e',
                    `using Pkg; Pkg.test("${folder.name}")`,
                ]

                const env = {}

                if (nthreads === 'auto') {
                    jlargs.splice(1, 0, '--threads=auto')
                } else {
                    env['FRICAS_NUM_THREADS'] = nthreads
                }
                const testTask = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'test'
                    },
                    folder,
                    `Run tests`,
                    'FriCAS',
                    new vscode.ProcessExecution(
                        fricasExecutable.file,
                        jlargs,
                        {
                            env: env
                        }
                    ),
                    ''
                )
                testTask.group = vscode.TaskGroup.Test
                testTask.presentationOptions = { echo: false, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(testTask)

                const jlargs2 = [
                    ...fricasExecutable.args,
                    '--color=yes',
                    `--project=${pkgenvpath}`,
                    path.join(
                        this.context.extensionPath,
                        'scripts',
                        'tasks',
                        'task_test.jl'
                    ),
                    folder.uri.fsPath,
                    vscode.workspace
                        .getConfiguration('fricas')
                        .get<boolean>('deleteFriCASCovFiles') ?? false
                        ? 'true'
                        : 'false',
                ]

                if (nthreads === 'auto') {
                    jlargs.splice(1, 0, '--threads=auto')
                }

                const testTaskWithCoverage = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'testcoverage'
                    },
                    folder,
                    `Run tests with coverage`,
                    'FriCAS',
                    new vscode.ProcessExecution(
                        fricasExecutable.file,
                        jlargs2,
                        {
                            env: env
                        }
                    ),
                    ''
                )
                testTaskWithCoverage.group = vscode.TaskGroup.Test
                testTaskWithCoverage.presentationOptions = { echo: false, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(testTaskWithCoverage)

                // const livetestTask = new vscode.Task({ type: 'fricas', command: 'livetest' }, folder, `Run tests live (experimental)`, 'fricas', new vscode.ProcessExecution(jlexepath, ['--color=yes', `--project=${pkgenvpath}`, path.join(this.context.extensionPath, 'scripts', 'tasks', 'task_liveunittesting.jl'), folder.name, vscode.workspace.getConfiguration('fricas').get('liveTestFile')], { env: { FRICAS_NUM_THREADS: inferFriCASNumThreads() } }), '')
                // livetestTask.group = vscode.TaskGroup.Test
                // livetestTask.presentationOptions = { echo: false, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                // result.push(livetestTask)

            }

            if (fricasExecutable.getVersion().compare('1.6.0') >= 0) {
                const buildFriCASSysimage = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'fricassysimagebuild',
                    },
                    folder,
                    `Build custom sysimage for current environment (experimental)`,
                    'FriCAS',
                    new vscode.ProcessExecution(fricasExecutable.file, [
                        ...fricasExecutable.args,
                        '--color=yes',
                        '--startup-file=no',
                        '--history-file=no',
                        path.join(
                            this.context.extensionPath,
                            'scripts',
                            'tasks',
                            'task_compileenv.jl'
                        ),
                        pkgenvpath,
                    ]),
                    ''
                )
                buildFriCASSysimage.group = vscode.TaskGroup.Build
                buildFriCASSysimage.presentationOptions = { echo: false, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(buildFriCASSysimage)
            }*/

            if (await fs.exists(path.join(rootPath, 'deps', 'build.jl'))) {
                const buildTask = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'build'
                    },
                    folder,
                    `Run build`,
                    'FriCAS',
                    new vscode.ProcessExecution(
                        fricasExecutable.file,
                        [
                            ...fricasExecutable.args,
                            '--color=yes',
                            `--project=${pkgenvpath}`,
                            '-e',
                            `using Pkg; Pkg.build("${folder.name}")`
                        ])
                    ,
                    ''
                )
                buildTask.group = vscode.TaskGroup.Build
                buildTask.presentationOptions = { echo: false, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(buildTask)
            }

            if (await fs.exists(path.join(rootPath, 'benchmark', 'benchmarks.jl'))) {
                const benchmarkTask = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'benchmark'
                    },
                    folder,
                    `Run benchmark`,
                    'FriCAS',
                    new vscode.ProcessExecution(
                        fricasExecutable.file,
                        [
                            ...fricasExecutable.args,
                            '--color=yes',
                            `--project=${pkgenvpath}`,
                            '-e',
                            'using PkgBenchmark; benchmarkpkg(Base.ARGS[1], resultfile="benchmark/results.json")',
                            folder.name
                        ]
                    ),
                    ''
                )
                benchmarkTask.presentationOptions = { echo: false, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(benchmarkTask)
            }

            if (await fs.exists(path.join(rootPath, 'docs', 'make.jl'))) {
                const buildTask = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'docbuild'
                    },
                    folder,
                    `Build documentation`,
                    'FriCAS',
                    new vscode.ProcessExecution(
                        fricasExecutable.file,
                        [
                            ...fricasExecutable.args,
                            `--project=${pkgenvpath}`,
                            '--color=yes',
                            path.join(this.context.extensionPath, 'scripts', 'tasks', 'task_docbuild.jl'),
                            path.join(rootPath, 'docs', 'make.jl'),
                            path.join(rootPath, 'docs', 'build', 'index.html')
                        ],
                        { cwd: rootPath }
                    ),
                    ''
                )
                buildTask.group = vscode.TaskGroup.Build
                buildTask.presentationOptions = { echo: false, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(buildTask)
            }

            return result
        } catch (e) {
            // TODO Let things crash and go to crash reporting
            return emptyTasks
        }
    }

    resolveTask(task: vscode.Task) {
        return undefined
    }
}

export function activate(context: vscode.ExtensionContext, fricasExecutablesFeature: FriCASExecutablesFeature) {
    vscode.tasks.registerTaskProvider('fricas', new FriCASTaskProvider(context, fricasExecutablesFeature))
}

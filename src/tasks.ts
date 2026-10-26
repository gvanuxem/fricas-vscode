import * as fs from 'async-file'
import * as path from 'path'
import * as vscode from 'vscode'
import { FriCASExecutablesFeature } from './fricasexepath'

class FriCASTaskProvider {
    constructor(private fricasExecutablesFeature: FriCASExecutablesFeature) { }

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
        const emptyTasks: vscode.Task[] = []

        if (folder.uri.scheme !== 'file') {
            return emptyTasks
        }
        const rootPath = folder.uri.fsPath

        try {
            const result: vscode.Task[] = []
            const fricasExecutable = await this.fricasExecutablesFeature.getActiveFriCASExecutableAsync()
            if (!fricasExecutable) {
                return emptyTasks
            }

            // Check for test.input or test/test.input
            const testInputPath = (await fs.exists(path.join(rootPath, 'test', 'test.input'))) ?
                path.join(rootPath, 'test', 'test.input') :
                (await fs.exists(path.join(rootPath, 'test.input'))) ? path.join(rootPath, 'test.input') : undefined

            if (testInputPath) {
                const testTask = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'test'
                    },
                    folder,
                    'Run FriCAS tests',
                    'FriCAS',
                    new vscode.ProcessExecution(
                        fricasExecutable.file,
                        [
                            ...fricasExecutable.args,
                            '-eval',
                            `)read ${testInputPath}`
                        ],
                        { cwd: rootPath }
                    ),
                    ''
                )
                testTask.group = vscode.TaskGroup.Test
                testTask.presentationOptions = { echo: true, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(testTask)
            }

            // Check for build.input or Makefile
            const buildInputPath = (await fs.exists(path.join(rootPath, 'build.input'))) ?
                path.join(rootPath, 'build.input') :
                (await fs.exists(path.join(rootPath, 'deps', 'build.input'))) ? path.join(rootPath, 'deps', 'build.input') : undefined

            if (buildInputPath) {
                const buildTask = new vscode.Task(
                    {
                        type: 'fricas',
                        command: 'build'
                    },
                    folder,
                    'Run FriCAS build',
                    'FriCAS',
                    new vscode.ProcessExecution(
                        fricasExecutable.file,
                        [
                            ...fricasExecutable.args,
                            '-eval',
                            `)read ${buildInputPath}`
                        ],
                        { cwd: rootPath }
                    ),
                    ''
                )
                buildTask.group = vscode.TaskGroup.Build
                buildTask.presentationOptions = { echo: true, focus: false, panel: vscode.TaskPanelKind.Dedicated, clear: true }
                result.push(buildTask)
            }

            return result
        } catch (e) {
            return emptyTasks
        }
    }

    resolveTask(task: vscode.Task) {
        return undefined
    }
}

export function activate(context: vscode.ExtensionContext, fricasExecutablesFeature: FriCASExecutablesFeature) {
    vscode.tasks.registerTaskProvider('fricas', new FriCASTaskProvider(fricasExecutablesFeature))
}

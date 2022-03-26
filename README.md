# A language server for FriCAS

FriCAS language server for Visual Studio Code

## Functionality

This extension contributes a virtual language, `fricas` which is the union of `SPAD` and `input` languages.

- Basic autocompletion
- Syntax highlighting
- Code folding
- Execute snippets or file content in input mode (CodeRunner plugin required)
- Algebra library compilation (CodeRunner plugin required)

![FriCAS-VSCode](https://user-images.githubusercontent.com/42774576/116650597-c7a09f80-a981-11eb-8472-bc5bd3d0cf69.png)

## Running the server

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to compile the client and server.
- Switch to the Debug viewlet.
- Select `Launch Client` from the drop down.
- Run the launch config.
- If you want to debug the server as well use the launch configuration `Attach to Server`

Note that if VS Code doesn't compile the extension, install globally `vsce` with `npm install -g vsce` and create a `.vix` installable package with, in fricas-vscode directory, `vsce package`.

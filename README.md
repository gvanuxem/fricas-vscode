# A language server for FriCAS

FriCAS language server for Visual Studio Code

## Functionality

This extension contributes a new language, `fricas` which represents the `SPAD` and `input` languages.

- Basic autocompletion
- Syntax highlighting
- Code folding
- Executing piece of code or full file in input mode (CodeRunner plugin required for now)
- Algebra library compilation (CodeRunner plugin required for now)

![FriCAS-VSCode](https://user-images.githubusercontent.com/42774576/116650597-c7a09f80-a981-11eb-8472-bc5bd3d0cf69.png)

## Running the server

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to compile the client and server.
- Switch to the Debug viewlet.
- Select `Launch Client` from the drop down.
- Run the launch config.
- If you want to debug the server as well use the launch configuration `Attach to Server`

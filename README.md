# Embedded FriCAS Languages using Language Service

FriCAS language server for Visual Studio Code

## Functionality

This extension contributes a new language, `fricas`.

- Basic autocompletion

This Language Server works for `spad` and `input` files.

- Syntax highlighting
- Completions based on open files (seen as a project)
- Code folding

## Running the server

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to compile the client and server.
- Switch to the Debug viewlet.
- Select `Launch Client` from the drop down.
- Run the launch config.
- If you want to debug the server as well use the launch configuration `Attach to Server`

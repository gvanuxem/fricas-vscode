# FriCAS VS Code extension

[![Build](https://github.com/gvanuxem/fricas-vscode/actions/workflows/main.yml/badge.svg)](https://github.com/gvanuxem/fricas-vscode/actions/workflows/main.yml)

This [VS Code](https://code.visualstudio.com) extension provides support for the [FriCAS Computer Algebra Software](https://fricas.github.io/).

## Getting started

### Installing FriCAS/VS Code/VS Code FriCAS extension
1. Install FriCAS for your platform: https://github.com/fricas/fricas/releases/
2. Install VS Code for your platform: https://code.visualstudio.com/download
    At the end of this step you should be able to start VS Code.
3.  1. Start VS Code.
    2. Inside VS Code, go to the extensions view either by
        executing the ``View: Show Extensions`` command (click View->Command Palette...)
        or by clicking on the extension icon on the left side of the VS Code
        window.
    3. In the extensions view, click at the top right, the three dots  ``...``
       and choose ``Install from VSIX...`` You will be able to choose
       the ``language-fricas-*.vsix`` VSIX file. Or in the ``Command  Palette...``
       execute ``Extensions: Install from VSIX...`` and choose the extension.

### Configure the FriCAS extension

If you have installed FriCAS into a standard location on Mac or Windows, or
if the FriCAS binary is on your ``PATH``, the FriCAS VS Code extension should
automatically find your FriCAS installation and you should not need to
configure anything.

If the extension does not find your FriCAS installation automatically, or
if you want to use a different FriCAS installation than the default one,
you can set the ``fricas.executablePath`` to point to the FriCAS executable
that the extension should use. In that case the
extension will always use that version of FriCAS. To edit your configuration
settings, execute the ``Preferences: Open User Settings`` command (you can
also access it via the menu ``File->Preferences->Settings``), and
then make sure your user settings include the ``fricas.executablePath``
setting. The format of the string should follow your platform specific
conventions, and be aware that the backlash ``\`` is the escape character
in JSON, so you need to use ``\\`` as the path separator character on Windows.

## Features

The extension currently provides:

* ``work in progress`` syntax highlighting
* ``work in progress`` FriCAS specific commands
* ``work in progress`` integrated FriCAS REPL
* ``work in progress`` code completion
* ``planned`` documentation navigation
* ``planned`` hover help
* ``work in progress`` code navigation
* ``planned`` debugger
* ``planned`` integrated plots


## Questions, Feature requests and contributions

1. If you face any issues, please open an issue [here](https://github.com/gvanuxem/fricas-vscode/issues).
2. If there is already an issue opened related to yours, please leave an upvote/downvote on the issue.
3. Contributions are always welcome!

import * as markdownit from 'markdown-it'
import * as path from 'path'
import * as vscode from 'vscode'
import { withLanguageClient } from '../extension'
import { constructCommandString, getVersionedParamsAtPosition, registerCommand } from '../utils'
import { g_connection, requestTypeGetDocAt, requestTypeGetDocFromWord } from '../interactive/repl'

function openArgs(href: string) {
    const matches = href.match(/^((\w+\:\/\/)?.+?)(?:[\:#](\d+))?$/)
    if (!matches) {
        return { uri: vscode.Uri.parse(href), line: undefined }
    }
    const uri = vscode.Uri.parse(matches[1])
    const line = matches[3] ? parseInt(matches[3]) : undefined
    return { uri, line }
}

const md = new markdownit().use(
    require('@traptitech/markdown-it-katex'),
    {
        output: 'html'
    }
).use(
    require('markdown-it-footnote')
)

// add custom validator to allow for file:// links
const BAD_PROTO_RE = /^(vbscript|javascript|data):/
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/
md.validateLink = (url) => {
    // url should be normalized at this point, and existing entities are decoded
    const str = url.trim().toLowerCase()

    return BAD_PROTO_RE.test(str) ? (GOOD_DATA_RE.test(str) ? true : false) : true
}

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const aIndex = tokens[idx].attrIndex('href')

    if (aIndex >= 0 && tokens[idx].attrs[aIndex][1] === '@ref' && tokens.length > idx + 1) {
        const commandUri = constructCommandString('language-fricas.search-word', { searchTerm: tokens[idx + 1].content })
        tokens[idx].attrs[aIndex][1] = vscode.Uri.parse(commandUri).toString()
    } else if (aIndex >= 0) {
        const href = tokens[idx].attrs[aIndex][1]
        const { uri, line } = openArgs(href)
        let commandUri
        if (line === undefined) {
            commandUri = constructCommandString('vscode.open', uri)
        } else {
            commandUri = constructCommandString('language-fricas.openFile', { path: uri.toString(), line })
        }
        tokens[idx].attrs[aIndex][1] = commandUri
    }

    return self.renderToken(tokens, idx, options)
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new DocumentationViewProvider(context)

    context.subscriptions.push(
        registerCommand('language-fricas.show-documentation-pane', () => provider.showDocumentationPane()),
        registerCommand('language-fricas.show-documentation', () => provider.showDocumentation()),
        registerCommand('language-fricas.browse-back-documentation', () => provider.browseBack()),
        registerCommand('language-fricas.browse-forward-documentation', () => provider.browseForward()),
        registerCommand('language-fricas.search-word', (params) => provider.findHelp(params)),
        vscode.window.registerWebviewViewProvider('fricas-documentation', provider),
        vscode.languages.registerHoverProvider({ scheme: 'file', language: 'fricas' }, provider)
    )
}

class DocumentationViewProvider implements vscode.WebviewViewProvider, vscode.HoverProvider {
    private view?: vscode.WebviewView
    private context: vscode.ExtensionContext

    private backStack = Array<string>() // also keep current page
    private forwardStack = Array<string>()

    constructor(context) {
        this.context = context
    }

    resolveWebviewView(view: vscode.WebviewView, context: vscode.WebviewViewResolveContext) {
        this.view = view

        view.webview.options = {
            enableScripts: true,
            enableCommandUris: true
        }
        view.webview.html = this.createWebviewHTML(this.getLandingPageMD())

        view.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'search') {
                this.showDocumentationFromWord(msg.query)
            } else if (msg.type === 'home') {
                this.showLandingPage()
            } else {
                console.error('unknown message received')
            }
        })
    }

    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
        const wordRange = document.getWordRangeAtPosition(position)
        if (!wordRange) { return null }
        const word = document.getText(wordRange)

        const docAsMD = await this.getDocumentationFromWord(word)
        if (!docAsMD || token.isCancellationRequested) { return null }

        const mdString = new vscode.MarkdownString(docAsMD)
        mdString.isTrusted = true
        return new vscode.Hover(mdString, wordRange)
    }

    findHelp(params: { searchTerm: string }) {
        this.showDocumentationFromWord(params.searchTerm)
    }

    async showLandingPage() {
        const html = this.createWebviewHTML(this.getLandingPageMD())
        this.setHTML(html)
    }

    async showDocumentationPane() {
        if (this.view?.show === undefined) {
            // this forces the webview to be resolved, but changes focus:
            await vscode.commands.executeCommand('fricas-documentation.focus')
        }
        this.view.show(true)
    }

    async showDocumentationFromWord(word: string) {
        await this.showDocumentationPane()
        this.setHTML(this.createWebviewHTML('### Searching for documentation...'))

        const docAsMD = await this.getDocumentationFromWord(word)
        const html = this.createWebviewHTML(docAsMD || `No documentation found for \`${word}\`.`)
        this.setHTML(html)
    }

    async getDocumentationFromWord(word: string): Promise<string> {
        const fetchPromise = (async () => {
            const lsResult = await withLanguageClient(
                async languageClient => {
                    return await languageClient.sendRequest<string>('fricas/getDocFromWord', { word: word })
                }, err => {
                    return ''
                }
            )
            if (lsResult) { return lsResult }

            if (g_connection) {
                try {
                    return await g_connection.sendRequest(requestTypeGetDocFromWord, { word: word })
                } catch (err) {
                    console.error('REPL request failed', err)
                }
            }
            return ''
        })()

        const timeoutPromise = new Promise<string>((resolve) => {
            setTimeout(() => resolve(''), 2000)
        })

        return Promise.race([fetchPromise, timeoutPromise])
    }

    async showDocumentation() {
        const editor = vscode.window.activeTextEditor
        if (!editor) { return }

        await this.showDocumentationPane()
        this.setHTML(this.createWebviewHTML('### Searching for documentation...'))

        const docAsMD = await this.getDocumentation(editor)

        this.forwardStack = [] // initialize forward page stack for manual search
        const html = this.createWebviewHTML(docAsMD || 'No documentation found at current position.')
        this.setHTML(html)
    }

    async getDocumentation(editor: vscode.TextEditor): Promise<string> {
        const params = getVersionedParamsAtPosition(editor.document, editor.selection.start)
        const fetchPromise = (async () => {
            const lsResult = await withLanguageClient(
                async languageClient => {
                    return await languageClient.sendRequest<string>('fricas/getDocAt', params)
                }, err => {
                    return ''
                }
            )
            if (lsResult) { return lsResult }

            if (g_connection) {
                try {
                    return await g_connection.sendRequest(requestTypeGetDocAt, params)
                } catch (err) {
                    console.error('REPL request failed', err)
                }
            }
            return ''
        })()

        const timeoutPromise = new Promise<string>((resolve) => {
            setTimeout(() => resolve(''), 2000)
        })

        return Promise.race([fetchPromise, timeoutPromise])
    }

    createWebviewHTML(docAsMD: string) {
        const docAsHTML = md.render(docAsMD)

        const extensionPath = this.context.extensionPath

        const googleFontscss = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'libs', 'google_fonts', 'css')))
        const fontawesomecss = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'libs', 'fontawesome', 'fontawesome.min.css')))
        const solidcss = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'libs', 'fontawesome', 'solid.min.css')))
        const brandscss = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'libs', 'fontawesome', 'brands.min.css')))
        const documenterStylesheetcss = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'libs', 'documenter', 'documenter-vscode.css')))
        const katexcss = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'libs', 'katex', 'katex.min.css')))

        const webfontjs = this.view.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'libs', 'webfont', 'webfont.js')))

        return `
    <html lang="en" class='theme--documenter-vscode'>

    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>FriCAS Documentation Pane</title>
        <link href=${googleFontscss} rel="stylesheet" type="text/css" />
        <link href=${fontawesomecss} rel="stylesheet" type="text/css" />
        <link href=${solidcss} rel="stylesheet" type="text/css" />
        <link href=${brandscss} rel="stylesheet" type="text/css" />
        <link href=${katexcss} rel="stylesheet" type="text/css" />
        <link href=${documenterStylesheetcss} rel="stylesheet" type="text/css">

        <script type="text/javascript">
            WebFontConfig = {
                custom: {
                    families: ['KaTeX_AMS', 'KaTeX_Caligraphic:n4,n7', 'KaTeX_Fraktur:n4,n7','KaTeX_Main:n4,n7,i4,i7', 'KaTeX_Math:i4,i7', 'KaTeX_Script','KaTeX_SansSerif:n4,n7,i4', 'KaTeX_Size1', 'KaTeX_Size2', 'KaTeX_Size3', 'KaTeX_Size4', 'KaTeX_Typewriter'],
                    urls: ['${katexcss}']
                },
            }
        </script>

        <style>
        body {
            word-break: normal;
            overflow-wrap: break-word;
        }
        body:active {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .search {
            position: fixed;
            background-color: var(--vscode-sideBar-background);
            width: 100%;
            padding: 5px;
            display: flex;
            z-index: 2;
        }
        .search input[type="text"] {
            width: 100%;
            background-color: var(--vscode-input-background);
            border: none;
            outline: none;
            color: var(--vscode-input-foreground);
            padding: 4px;
        }
        .search input[type="text"]:focus {
            outline: 1px solid var(--vscode-editorWidget-border);
        }
        button {
            width: 30px;
            margin: 0 5px 0 0;
            display: inline;
            border: none;
            box-sizing: border-box;
            padding: 5px 7px;
            text-align: center;
            cursor: pointer;
            justify-content: center;
            align-items: center;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-family: var(--vscode-font-family);
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 0px;
        }
        </style>

        <script src=${webfontjs}></script>
    </head>

    <body>
        <div class="search">
            <button id="home-button" title="Go to Home"><i class="fas fa-home"></i></button>
            <input id="search-input" type="text" placeholder="Search"></input>
        </div>
        <div class="docs-main" style="padding: 50px 1em 1em 1em">
            <article class="content">
                ${docAsHTML}
            </article>
        </div>
        <script>
            const vscode = acquireVsCodeApi()

            function search(val) {
                if (val) {
                    vscode.postMessage({
                        type: 'search',
                        query: val
                    })
                }
            }
            function onKeyDown(ev) {
                if (ev && ev.keyCode === 13) {
                    const val = document.getElementById('search-input').value
                    search(val)
                }
            }
            document.getElementById('search-input').addEventListener('keydown', onKeyDown)
            document.getElementById('home-button').addEventListener('click', () => {
                vscode.postMessage({ type: 'home' })
            })
        </script>
    </body>

    </html>
    `
    }

    setHTML(html: string) {
        // set current stack
        this.backStack.push(html)

        if (this.view) {
            this.view.webview.html = html
        }
    }

    isBrowseBackAvailable() {
        return this.backStack.length > 1
    }

    isBrowseForwardAvailable() {
        return this.forwardStack.length > 0
    }

    browseBack() {
        if (!this.isBrowseBackAvailable()) { return }

        const current = this.backStack.pop()
        this.forwardStack.push(current)

        this.setHTML(this.backStack.pop())
    }

    browseForward() {
        if (!this.isBrowseForwardAvailable()) { return }

        this.setHTML(this.forwardStack.pop())
    }

    private getLandingPageMD() {
        return `
# FriCAS Documentation

Welcome to the FriCAS documentation pane!

You can search for documentation for domains, categories, packages, and operations by using the search bar above.

Alternatively, place your cursor on a word in the editor and use the **FriCAS: Show Documentation** command (shortcut: \`Alt+J Alt+D\`).

### Useful links:
* [FriCAS Library Documentation](${vscode.workspace.getConfiguration('fricas').get<string>('documentationFilePath')})
* [FriCAS API Documentation](https://fricas.github.io/api/)
* [FriCAS Knowledge Base](https://github.com/fricas/fricas/wiki)
`
    }
}

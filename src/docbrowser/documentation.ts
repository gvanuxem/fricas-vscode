import * as markdownit from 'markdown-it'
import * as path from 'path'
import * as vscode from 'vscode'
import { withLanguageClient } from '../extension'
import { constructCommandString, getVersionedParamsAtPosition, registerCommand } from '../utils'
import { g_connection, requestTypeGetDocAt, requestTypeGetDocFromWord, executeInREPL } from '../interactive/repl'

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

    private viewReadyResolve?: () => void
    private viewReadyPromise: Promise<void>

    constructor(context) {
        this.context = context
        this.viewReadyPromise = new Promise(resolve => {
            this.viewReadyResolve = resolve
        })
    }

    resolveWebviewView(view: vscode.WebviewView, context: vscode.WebviewViewResolveContext) {
        this.view = view

        view.webview.options = {
            enableScripts: true,
            enableCommandUris: true
        }
        this.setHTML(this.createWebviewHTML(this.getLandingPageMD()))

        view.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'search') {
                this.showDocumentationFromWord(msg.query)
            } else if (msg.type === 'home') {
                this.showLandingPage()
            } else {
                console.error('unknown message received')
            }
        })

        this.viewReadyResolve?.()
    }

    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
        const wordRange = document.getWordRangeAtPosition(position)
        if (!wordRange) { return null }
        const word = document.getText(wordRange)

        // Don't auto-start a REPL from hover — only use existing connections
        const docAsMD = await this.getDocumentationFromWord(word, false)
        if (!docAsMD || token.isCancellationRequested) { return null }

        const mdString = new vscode.MarkdownString(docAsMD)
        const commandUri = vscode.Uri.parse(`command:language-fricas.search-word?${encodeURIComponent(JSON.stringify({ searchTerm: word }))}`)
        mdString.appendMarkdown(`\n\n---\n\n[Show in Documentation Pane](${commandUri.toString()})`)
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
        if (!this.view) {
            // this forces the webview to be resolved, but changes focus:
            vscode.commands.executeCommand('fricas-documentation.focus')
            await this.viewReadyPromise
        }
        if (this.view) {
            this.view.show(true)
        }
    }

    async showDocumentationFromWord(word: string) {
        if (!word || word.trim().length === 0) {
            this.showLandingPage()
            return
        }
        word = word.trim()
        await this.showDocumentationPane()
        this.setHTML(this.createWebviewHTML('### Searching for documentation...', word))

        const docAsMD = await this.getDocumentationFromWord(word)
        const html = this.createWebviewHTML(docAsMD || `No documentation found for \`${word}\`.`, word)
        this.setHTML(html)
    }

    async getDocumentationFromWord(word: string, allowStartREPL: boolean = true): Promise<string> {
        const fetchPromise = (async () => {
            // Try language client first (LSP)
            const lsResult = await withLanguageClient(
                async languageClient => {
                    return await languageClient.sendRequest<string>('repl/getDocFromWord', { word: word })
                }, err => {
                    return ''
                }
            )
            if (lsResult) { return this.cleanReplDocResult(lsResult) }

            // Try REPL message connection
            if (g_connection) {
                try {
                    let replResult = await g_connection.sendRequest(requestTypeGetDocFromWord, { word: word })
                    if (replResult && replResult.trim().length > 0) { return replResult }

                    // If not found, try as constructor
                    replResult = await g_connection.sendRequest(requestTypeGetDocFromWord, { word: word, type: 'constructor' })
                    if (replResult && replResult.trim().length > 0) { return replResult }
                } catch (err) {
                    console.error('REPL message request failed, trying direct eval', err)
                }
            }

            // Fallback: directly evaluate FriCAS documentation commands via REPL
            // Only attempt if REPL is already running or we're allowed to start one
            if (g_connection || allowStartREPL) {
                try {
                    const opResult = await executeInREPL(
                        `operationDocumentation("${word}")$SDOC`,
                        { showCodeInREPL: false, showResultInREPL: false, showErrorInREPL: false }
                    )
                    const opDoc = this.cleanReplDocResult(opResult?.inline || opResult?.all || '')
                    if (opDoc) { return opDoc }

                    const conResult = await executeInREPL(
                        `constructorDocumentation("${word}")$SDOC`,
                        { showCodeInREPL: false, showResultInREPL: false, showErrorInREPL: false }
                    )
                    const conDoc = this.cleanReplDocResult(conResult?.inline || conResult?.all || '')
                    if (conDoc) { return conDoc }

                    // Pattern search fallback
                    if (word.includes('*') || word.includes('?')) {
                        const listResult = await executeInREPL(
                            `listConstructors("${word}")$SDOC`,
                            { showCodeInREPL: false, showResultInREPL: false, showErrorInREPL: false }
                        )
                        const listDoc = this.cleanReplDocResult(listResult?.inline || listResult?.all || '')
                        if (listDoc && listDoc !== '[]') {
                            return `### Matching constructors:\n\n${listDoc}`
                        }
                    }
                } catch (err) {
                    console.error('Direct REPL eval for doc failed', err)
                }
            }
            return ''
        })()

        const timeoutPromise = new Promise<string>((resolve) => {
            setTimeout(() => resolve(''), 10000)
        })

        return Promise.race([fetchPromise, timeoutPromise])
    }

    private cleanReplDocResult(text: string | any): string {
        if (!text) { return '' }
        if (typeof text !== 'string') {
            // Handle case where result might be an object (e.g. Hover result)
            if (text.contents && text.contents.value) {
                text = text.contents.value
            } else if (text.value) {
                text = text.value
            } else {
                text = JSON.stringify(text)
            }
        }
        // Strip surrounding whitespace
        let cleaned = text.trim()
        // Remove trailing FriCAS types
        cleaned = cleaned.replace(/\s*Type:\s*(?:String|Void)\s*$/, '').trim()
        // Strip surrounding quotes if present
        if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
            cleaned = cleaned.slice(1, -1)
        }
        // Unescape newlines (both actual and literal \n)
        cleaned = cleaned.replace(/\\n/g, '\n').replace(/\\"/g, '"')
        return cleaned
    }

    async showDocumentation() {
        const editor = vscode.window.activeTextEditor
        if (!editor) { return }

        const wordRange = editor.document.getWordRangeAtPosition(editor.selection.start)
        const word = wordRange ? editor.document.getText(wordRange) : ''

        await this.showDocumentationPane()
        this.setHTML(this.createWebviewHTML('### Searching for documentation...', word))

        const docAsMD = await this.getDocumentation(editor)

        this.forwardStack = [] // initialize forward page stack for manual search
        const html = this.createWebviewHTML(docAsMD || 'No documentation found at current position.', word)
        this.setHTML(html)
    }

    async getDocumentation(editor: vscode.TextEditor): Promise<string> {
        const wordRange = editor.document.getWordRangeAtPosition(editor.selection.start)
        const word = wordRange ? editor.document.getText(wordRange) : undefined
        const posParams = getVersionedParamsAtPosition(editor.document, editor.selection.start)
        const params = { ...posParams, word: word }

        const fetchPromise = (async () => {
            const lsResult = await withLanguageClient(
                async languageClient => {
                    return await languageClient.sendRequest<string>('repl/getDocAt', params)
                }, err => {
                    return ''
                }
            )
            if (lsResult) { return this.cleanReplDocResult(lsResult) }

            if (g_connection) {
                try {
                    let replResult = await g_connection.sendRequest(requestTypeGetDocAt, params)
                    if (replResult && replResult.trim().length > 0) { return replResult }

                    // If not found, try as constructor
                    replResult = await g_connection.sendRequest(requestTypeGetDocAt, { ...params, type: 'constructor' })
                    if (replResult && replResult.trim().length > 0) { return replResult }
                } catch (err) {
                    console.error('REPL message request failed, trying direct eval', err)
                }
            }

            // Fallback: extract word at cursor and evaluate FriCAS doc commands
            try {
                const wordRange = editor.document.getWordRangeAtPosition(editor.selection.start)
                if (wordRange) {
                    const word = editor.document.getText(wordRange)
                    return await this.getDocumentationFromWord(word)
                }
            } catch (err) {
                console.error('Direct REPL eval for doc failed', err)
            }
            return ''
        })()

        const timeoutPromise = new Promise<string>((resolve) => {
            setTimeout(() => resolve(''), 10000)
        })

        return Promise.race([fetchPromise, timeoutPromise])
    }

    createWebviewHTML(docAsMD: string, query: string = '') {
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
            <input id="search-input" type="text" placeholder="Search" value="${query.replace(/"/g, '&quot;')}"></input>
            <button id="search-button" title="Search"><i class="fas fa-search"></i></button>
        </div>
        <div class="docs-main" style="padding: 50px 1em 1em 1em">
            <article class="content">
                ${docAsHTML}
            </article>
        </div>
        <script>
            const vscodeApi = acquireVsCodeApi()

            function search(val) {
                if (val) {
                    vscodeApi.postMessage({
                        type: 'search',
                        query: val
                    })
                }
            }
            function onKeyDown(ev) {
                if (ev && ev.key === 'Enter') {
                    const val = document.getElementById('search-input').value
                    search(val)
                }
            }
            const searchInput = document.getElementById('search-input')
            searchInput.addEventListener('keydown', onKeyDown)
            document.getElementById('search-button').addEventListener('click', () => {
                const val = searchInput.value
                search(val)
            })
            // Restore focus and selection at the end
            searchInput.focus()
            if (searchInput.value) {
                searchInput.setSelectionRange(0, searchInput.value.length)
            }

            document.getElementById('home-button').addEventListener('click', () => {
                vscodeApi.postMessage({ type: 'home' })
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
* [FriCAS Local Library Documentation](${vscode.workspace.getConfiguration('fricas').get<string>('documentationFilePath')})
* [jlFriCAS home page](https://gvanuxem.github.io/jlfricas/)
* [jlFriCAS Documentation pages](https://gvanuxem.github.io/jlfricas.documentation/)
* [FriCAS API Documentation](https://fricas.github.io/api/)
`
    }
}

import * as vscode from 'vscode'

export const continuationRegex = /(?:^|[^\_])(?:\_\_)*\_[ \t]*$/

export function countUnclosedBrackets(text: string): number {
    let depth = 0
    let inString = false
    let i = 0
    while (i < text.length) {
        const c = text[i]

        if (inString) {
            if (c === '_' && i + 1 < text.length) {
                i += 2
                continue
            }
            if (c === '"') {
                inString = false
            }
            i++
            continue
        }

        if (c === '-' && i + 1 < text.length && text[i + 1] === '-') {
            break
        }
        if (c === '+' && i + 1 < text.length && text[i + 1] === '+') {
            break
        }

        if (c === '"') {
            inString = true
            i++
            continue
        }

        if (c === '(' || c === '[' || c === '{') {
            depth++
        } else if (c === ')' || c === ']' || c === '}') {
            if (depth > 0) {
                depth--
            }
        }

        i++
    }
    return depth
}

export class FriCASDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    public provideDocumentSymbols(
        document: vscode.TextDocument,
        token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]>
        {
        return new Promise((resolve, reject) =>
        {
            const symbols: vscode.DocumentSymbol[] = []
            const nodes = [symbols]
            let inside_modules = false
            let inside_function = false

            const symbolkind_doc = vscode.SymbolKind.Field

            let i = 0
            while (i < document.lineCount) {
                const startLine = document.lineAt(i)
                if (startLine.text.match(/^\s*--/) || startLine.text.match(/^ \s+\+\+\s\s/)) {
                    i++
                    continue
                }

                let endLine = startLine
                let combinedText = startLine.text
                const MAX_CONTINUATION_LINES = 50
                let continuationCount = 0

                while (endLine.lineNumber + 1 < document.lineCount && continuationCount < MAX_CONTINUATION_LINES) {
                    const hasEscape = continuationRegex.test(combinedText)
                    const unclosedBrackets = countUnclosedBrackets(combinedText)
                    const hasDefinitionOp = combinedText.includes('==')

                    const shouldContinue = hasEscape || (unclosedBrackets > 0 && !hasDefinitionOp)
                    if (!shouldContinue) {
                        break
                    }

                    const nextLine = document.lineAt(endLine.lineNumber + 1)
                    const trimmedNext = nextLine.text.trim()

                    if (trimmedNext.startsWith(')')) {
                        break
                    }

                    endLine = nextLine
                    continuationCount++

                    if (hasEscape) {
                        combinedText = combinedText.replace(/_[ \t]*$/, '')
                    }

                    if (trimmedNext.startsWith('--') || trimmedNext.startsWith('++')) {
                        continue
                    }

                    combinedText = combinedText + (combinedText.endsWith(' ') || trimmedNext.startsWith(' ') ? '' : ' ') + trimmedNext
                }

                i = endLine.lineNumber + 1

                const symbolRange = new vscode.Range(startLine.range.start, endLine.range.end)
                const selectionRange = startLine.range

                // TODO: Bad hack
                // foo(x) == if x = "==" then "==" else ""
                // TODO: definition inside definition (Boot):
                // "append"/[[f for j in 1..ncols] for i in 1..nrows] where f ==
                if (combinedText.startsWith(')package')) {
                    const tokens = combinedText.split(/\s+/g)
                    const name = tokens[1] || 'package'
                    const user_symbol = new vscode.DocumentSymbol(
                        name,
                        tokens[0],
                        vscode.SymbolKind.Package,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(user_symbol)
                    nodes.push(user_symbol.children)
                }
                else if (combinedText.startsWith(')abbrev')) {
                    const tokens = combinedText.split(/\s+/g)
                    if (inside_function && nodes.length > 1) {
                        nodes.pop()
                        inside_function = false
                    }
                    if (inside_modules && nodes.length > 1) {
                        nodes.pop()
                    } else {
                        inside_modules = true
                    }
                    const name = tokens[3] || tokens[2] || 'Constructor'
                    const kindStr = tokens[1] || 'domain'
                    const symKind = kindStr === 'category' ? vscode.SymbolKind.Interface :
                                    kindStr === 'package' ? vscode.SymbolKind.Package : vscode.SymbolKind.Class
                    const user_symbol = new vscode.DocumentSymbol(
                        name,
                        kindStr,
                        symKind,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(user_symbol)
                    nodes.push(user_symbol.children)
                }
                else if (combinedText.match(/^\+\+\s[a-zA-Z][a-zA-Z\s]+:/)) {
                    const tokens = combinedText.split(/:/g)
                    const marker_symbol = new vscode.DocumentSymbol(
                        tokens[0].trim(),
                        'Documentation',
                        symbolkind_doc,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(marker_symbol)
                }
                else if (combinedText.match(/\s+\w+\s*.*==>/g)) {
                    const tokens = combinedText.split(/==>/g)
                    const marker_symbol = new vscode.DocumentSymbol(
                        tokens[0].trim(),
                        'Macro',
                        vscode.SymbolKind.Constant,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(marker_symbol)
                }
                else if (combinedText.match(/\s*\w[\?!]?.*==/g) && !combinedText.match('where')) {
                    const tokens = combinedText.split(/==/g)
                    if (inside_function && nodes.length > 1) {
                        nodes.pop()
                    }
                    const marker_symbol = new vscode.DocumentSymbol(
                        tokens[0].trim(),
                        'Definition',
                        vscode.SymbolKind.Function,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(marker_symbol)
                    nodes.push(marker_symbol.children)
                    inside_function = true
                }
                else if (combinedText.match(/\s+\w+.*[-*+\/<>=^].*==/g) ||
                            combinedText.match(/\s+-.*==/g)) {
                    const tokens = combinedText.split(/==/g)
                    if (inside_function && nodes.length > 1) {
                        nodes.pop()
                    }
                    const marker_symbol = new vscode.DocumentSymbol(
                        tokens[0].trim(),
                        'Definition',
                        vscode.SymbolKind.Operator,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(marker_symbol)
                    nodes.push(marker_symbol.children)
                    inside_function = true
                }
                else if (combinedText.match(/\s+\w+\s*.*:=/g)) {
                    const tokens = combinedText.trim().split(/\s*:=/g)
                    const varName = tokens[0] ? tokens[0].trim() : 'Variable'
                    const cmd_symbol = new vscode.DocumentSymbol(
                        varName,
                        'Variable',
                        vscode.SymbolKind.Variable,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(cmd_symbol)
                }
                else if (combinedText.match(/\s*(?:[\w\?!]+|_[-*+\/<>=^~]+|[-*+\/<>=^]+|"[^"]+")\s*:.*->/g)) {
                    const cmd_symbol = new vscode.DocumentSymbol(
                        combinedText.trim(),
                        'Signature',
                        vscode.SymbolKind.TypeParameter,
                        symbolRange, selectionRange)
                    nodes[nodes.length-1].push(cmd_symbol)
                }
            }
            resolve(symbols)
        })
        }
}

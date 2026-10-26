import * as vscode from 'vscode'

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

            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i)
                if (!line.text.match(/^\s*--/) && !line.text.match(/^ \s+\+\+\s\s/)) {
                    // TODO: Bad hack
                    // foo(x) == if x = "==" then "==" else ""
                    // TODO: definition inside definition (Boot):
                    // "append"/[[f for j in 1..ncols] for i in 1..nrows] where f ==
                    if (line.text.startsWith(')package')) {
                        const tokens = line.text.split(/\s+/g)
                        const name = tokens[1] || 'package'
                        const user_symbol = new vscode.DocumentSymbol(
                            name,
                            tokens[0],
                            vscode.SymbolKind.Package,
                            line.range, line.range)
                        nodes[nodes.length-1].push(user_symbol)
                        nodes.push(user_symbol.children)
                    }
                    else if (line.text.startsWith(')abbrev')) {
                        const tokens = line.text.split(/\s+/g)
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
                            line.range, line.range)
                        nodes[nodes.length-1].push(user_symbol)
                        nodes.push(user_symbol.children)
                    }
                    else if (line.text.match(/^\+\+\s[a-zA-Z][a-zA-Z\s]+:/)) {
                        const tokens = line.text.split(/:/g)
                        const marker_symbol = new vscode.DocumentSymbol(
                            tokens[0].trim(),
                            'Documentation',
                            symbolkind_doc,
                            line.range, line.range)
                        nodes[nodes.length-1].push(marker_symbol)
                    }
                    else if (line.text.match(/\s+\w+\s*.*==>/g)) {
                        const tokens = line.text.split(/==>/g)
                        const marker_symbol = new vscode.DocumentSymbol(
                            tokens[0].trim(),
                            'Macro',
                            vscode.SymbolKind.Constant,
                            line.range, line.range)
                        nodes[nodes.length-1].push(marker_symbol)
                    }
                    else if (line.text.match(/\s*\w[\?!]?.*==/g) && !line.text.match('where')) {
                        const tokens = line.text.split(/==/g)
                        if (inside_function && nodes.length > 1) {
                            nodes.pop()
                        }
                        const marker_symbol = new vscode.DocumentSymbol(
                            tokens[0].trim(),
                            'Definition',
                            vscode.SymbolKind.Function,
                            line.range, line.range)
                        nodes[nodes.length-1].push(marker_symbol)
                        nodes.push(marker_symbol.children)
                        inside_function = true
                    }
                    else if (line.text.match(/\s+\w+.*[-*+\/<>=^].*==/g) ||
                                line.text.match(/\s+-.*==/g)) {
                        const tokens = line.text.split(/==/g)
                        if (inside_function && nodes.length > 1) {
                            nodes.pop()
                        }
                        const marker_symbol = new vscode.DocumentSymbol(
                            tokens[0].trim(),
                            'Definition',
                            vscode.SymbolKind.Operator,
                            line.range, line.range)
                        nodes[nodes.length-1].push(marker_symbol)
                        nodes.push(marker_symbol.children)
                        inside_function = true
                    }
                    else if (line.text.match(/\s+\w+\s*.*:=/g)) {
                        const tokens = line.text.trim().split(/\s*:=/g)
                        const varName = tokens[0] ? tokens[0].trim() : 'Variable'
                        const cmd_symbol = new vscode.DocumentSymbol(
                            varName,
                            'Variable',
                            vscode.SymbolKind.Variable,
                            line.range, line.range)
                        nodes[nodes.length-1].push(cmd_symbol)
                    }
                    else if (line.text.match(/\s+\w+[\?!]?\s*:.*->/g)) {
                        const cmd_symbol = new vscode.DocumentSymbol(
                            line.text,
                            'Signature',
                            vscode.SymbolKind.TypeParameter,
                            line.range, line.range)
                        nodes[nodes.length-1].push(cmd_symbol)
                    }
                }
            }
            resolve(symbols)
        })
        }
}

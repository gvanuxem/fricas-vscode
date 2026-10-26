import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import * as ext from '../../extension'
import { parseDiagnosticLines } from '../../compiler'
import { continuationRegex, countUnclosedBrackets } from '../../outline'

suite('FriCAS Indentation Rules', () => {
    test('repeat loops', () => {
        assert.strictEqual(ext.increaseIndentPattern.test('for i in 1..10 repeat'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('  while x > 0 repeat'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('repeat'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('-- for i in 1..10 repeat'), false)
    })

    test('conditionals and exception blocks', () => {
        assert.strictEqual(ext.increaseIndentPattern.test('if x > 0 then'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('else'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('try'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('finally'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('catch'), true)
        assert.strictEqual(ext.decreaseIndentPattern.test('else'), true)
        assert.strictEqual(ext.decreaseIndentPattern.test('finally'), true)
        assert.strictEqual(ext.decreaseIndentPattern.test('catch'), true)
        assert.strictEqual(ext.decreaseIndentPattern.test('  else'), true)
        assert.strictEqual(ext.decreaseIndentPattern.test('}'), true)
        assert.strictEqual(ext.decreaseIndentPattern.test(']'), true)
        assert.strictEqual(ext.decreaseIndentPattern.test(')'), true)
    })

    test('function and macro definitions', () => {
        assert.strictEqual(ext.increaseIndentPattern.test('f(x) =='), true)
        assert.strictEqual(ext.increaseIndentPattern.test('f(x: Integer): Integer =='), true)
        assert.strictEqual(ext.increaseIndentPattern.test('myMacro(a, b) ==>'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('x := 1'), false)
        assert.strictEqual(ext.increaseIndentPattern.test('x := '), true)
    })

    test('SPAD structural blocks', () => {
        assert.strictEqual(ext.increaseIndentPattern.test('MyDomain(): Exports == Implementation where'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('Exports ==> with'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('Implementation ==> add'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('{'), true)
        assert.strictEqual(ext.increaseIndentPattern.test('('), true)
        assert.strictEqual(ext.increaseIndentPattern.test('['), true)
    })
})

suite('FriCAS Compiler Diagnostic Parser', () => {
    test('parses compiler syntax error with line number', () => {
        const sampleOutput = `
   Compiling FriCAS source code from file /tmp/test.spad using Spad compiler
   Line 42: syntax error at or near '=='
`
        const diagnostics = parseDiagnosticLines(sampleOutput)
        assert.strictEqual(diagnostics.length, 1)
        assert.strictEqual(diagnostics[0].line, 41)
        assert.strictEqual(diagnostics[0].isError, true)
        assert.ok(diagnostics[0].message.includes('syntax error'))
    })

    test('parses compiler fatal error with "on line N"', () => {
        const sampleOutput = `
   >> Error: Undefined symbol 'Foo' on line 15
`
        const diagnostics = parseDiagnosticLines(sampleOutput)
        assert.strictEqual(diagnostics.length, 1)
        assert.strictEqual(diagnostics[0].line, 14)
        assert.strictEqual(diagnostics[0].isError, true)
    })

    test('parses compiler warning with bracket line number [N]', () => {
        const sampleOutput = `
   [10] warning: unused variable 'k' in function 'bar'
`
        const diagnostics = parseDiagnosticLines(sampleOutput)
        assert.strictEqual(diagnostics.length, 1)
        assert.strictEqual(diagnostics[0].line, 9)
        assert.strictEqual(diagnostics[0].isError, false)
    })

    test('ignores non-error compilation output', () => {
        const sampleOutput = `
   Compiling FriCAS source code from file /tmp/test.spad using Spad compiler
   Processing /tmp/test.spad
   0 error(s), 0 warning(s)
`
        const diagnostics = parseDiagnosticLines(sampleOutput)
        assert.strictEqual(diagnostics.length, 0)
    })
})

suite('FriCAS Numeric Literals Syntax', () => {
    const grammarPath = path.resolve(__dirname, '../../../syntaxes/fricas.vscode.json')
    const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'))
    const numberPatterns: Array<{ match: string; name: string }> = grammar.repository.number.patterns

    const radixPattern = new RegExp(numberPatterns.find(p => p.name === 'constant.numeric.radix.fricas')!.match)
    const floatPatterns = numberPatterns
        .filter(p => p.name === 'constant.numeric.float.fricas')
        .map(p => new RegExp(p.match))
    const integerPattern = new RegExp(numberPatterns.find(p => p.name === 'constant.numeric.integer.fricas')!.match)

    const matchesFloat = (text: string) => floatPatterns.some(p => p.test(text))
    const matchesInteger = (text: string) => integerPattern.test(text)
    const matchesRadix = (text: string) => radixPattern.test(text)

    test('floating point numbers with scientific notation and dot', () => {
        assert.strictEqual(matchesFloat('1.e-20'), true)
        assert.strictEqual(matchesFloat('1.E-20'), true)
        assert.strictEqual(matchesFloat('1.e2'), true)
        assert.strictEqual(matchesFloat('1.E2'), true)
        assert.strictEqual(matchesFloat('1.3e11'), true)
        assert.strictEqual(matchesFloat('1.3E11'), true)
        assert.strictEqual(matchesFloat('1.3e-11'), true)
        assert.strictEqual(matchesFloat('1.3e+11'), true)
        assert.strictEqual(matchesFloat('1.0e-20'), true)
        assert.strictEqual(matchesFloat('1.0E-20'), true)
        assert.strictEqual(matchesFloat('1.0'), true)
        assert.strictEqual(matchesFloat('1.'), true)
    })

    test('floating point numbers with leading dot', () => {
        assert.strictEqual(matchesFloat('.5'), true)
        assert.strictEqual(matchesFloat('.5e-2'), true)
        assert.strictEqual(matchesFloat('.5E-2'), true)
        assert.strictEqual(matchesFloat('.5e2'), true)
    })

    test('integers and numbers without dot are not floats in jlFriCAS', () => {
        assert.strictEqual(matchesFloat('1e-20'), false)
        assert.strictEqual(matchesFloat('1E-20'), false)
        assert.strictEqual(matchesFloat('1e2'), false)
        assert.strictEqual(matchesFloat('1E2'), false)
        assert.strictEqual(matchesFloat('42'), false)
        assert.strictEqual(matchesInteger('42'), true)
    })

    test('range operator 1..10 is not matched as float', () => {
        assert.strictEqual(matchesFloat('1..10'), false)
    })

    test('radix numbers', () => {
        assert.strictEqual(matchesRadix('16rFF'), true)
        assert.strictEqual(matchesFloat('16rFF'), false)
    })
})

suite('FriCAS Outline Line Continuation and Brackets', () => {
    test('detects underscore continuation lines', () => {
        assert.strictEqual(continuationRegex.test('    extract_brace(s : String, pos : Integer) : _'), true)
        assert.strictEqual(continuationRegex.test('    listConstructors : Symbol -> Record(categories: List(Symbol), _  '), true)
        assert.strictEqual(continuationRegex.test('foo__'), false) // __ is escaped underscore
        assert.strictEqual(continuationRegex.test('foo___'), true)  // ___ is escaped underscore + unescaped _
        assert.strictEqual(continuationRegex.test('normal line without underscore'), false)
    })

    test('counts unclosed brackets and handles strings/comments', () => {
        assert.strictEqual(countUnclosedBrackets('extract_brace(s : String, pos : Integer) : _'), 0)
        assert.strictEqual(countUnclosedBrackets('alg_exquo(a : MP, b : MP, lm : LMP, xvars : List OV,'), 1)
        assert.strictEqual(countUnclosedBrackets('alg_exquo(a : MP, b : MP, lm : LMP, xvars : List OV, zvars : List OV) : Union(MP, "failed") =='), 0)
        assert.strictEqual(countUnclosedBrackets('msg := "unclosed ( paren in string"'), 0)
        assert.strictEqual(countUnclosedBrackets('x := 1 -- (comment with open paren'), 0)
        assert.strictEqual(countUnclosedBrackets('++ docstring with open ( paren'), 0)
        assert.strictEqual(countUnclosedBrackets('nested [{(brackets)}]'), 0)
        assert.strictEqual(countUnclosedBrackets('nested [{(open'), 3)
    })
})


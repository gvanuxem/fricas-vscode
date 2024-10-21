import * as assert from 'assert'
import { suite, test } from 'mocha'
import * as utils from '../../utils'


// TODO figure out how to mock vscode.workspace.getConfiguration("fricas")
suite('Test FRICAS_NUM_THREADS config', () => {
    test('null config and defined environment var', () => {
        assert.equal(utils.inferFriCASNumThreads(), '')
    })
    test('null config and defined environment var', () => {
        assert.equal(utils.inferFriCASNumThreads(), '')

    })
    test('not null config and defined environment var', () => {
        assert.equal(utils.inferFriCASNumThreads(), '')
    })
    test('not null config and undefined environment var', () => {
        assert.equal(utils.inferFriCASNumThreads(), '')
    })

})

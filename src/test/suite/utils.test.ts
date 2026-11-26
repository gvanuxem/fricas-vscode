import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import { suite, test } from 'mocha'
import * as utils from '../../utils'

suite('Utils Tests', () => {
    test('inferFriCASNumThreads uses FRICAS_NUM_THREADS env var when config is unset', () => {
        const prev = process.env['FRICAS_NUM_THREADS']
        try {
            process.env['FRICAS_NUM_THREADS'] = '4'
            assert.strictEqual(utils.inferFriCASNumThreads(), '4')

            delete process.env['FRICAS_NUM_THREADS']
            assert.strictEqual(utils.inferFriCASNumThreads(), '')
        } finally {
            if (prev === undefined) {
                delete process.env['FRICAS_NUM_THREADS']
            } else {
                process.env['FRICAS_NUM_THREADS'] = prev
            }
        }
    })

    test('resolvePath expands ~ and env variables', () => {
        const prev = process.env['FRICAS_TEST_VAR']
        try {
            process.env['FRICAS_TEST_VAR'] = 'custom_dir'
            assert.strictEqual(utils.resolvePath('~/test'), path.normalize(path.join(os.homedir(), 'test')))
            assert.strictEqual(utils.resolvePath('/tmp/${env:FRICAS_TEST_VAR}/sub'), path.normalize('/tmp/custom_dir/sub'))
        } finally {
            if (prev === undefined) {
                delete process.env['FRICAS_TEST_VAR']
            } else {
                process.env['FRICAS_TEST_VAR'] = prev
            }
        }
    })

    test('constructCommandString formats command URI', () => {
        const uri = utils.constructCommandString('language-fricas.search-word', { searchTerm: 'Matrix' })
        assert.strictEqual(uri, 'command:language-fricas.search-word?%7B%22searchTerm%22%3A%22Matrix%22%7D')
    })
})

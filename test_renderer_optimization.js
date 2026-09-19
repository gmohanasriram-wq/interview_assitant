const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
    console.log('[TEST_RENDERER] Starting renderer optimization test suite...');

    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Load an HTML page that imports marked, DOMPurify, Lit, and AssistantView
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js"></script>
    </head>
    <body>
        <div id="container"></div>
        <script type="module">
            import { AssistantView } from './src/components/views/AssistantView.js';

            window.runTestSuite = async function() {
                const results = {
                    passed: 0,
                    failed: 0,
                    tests: []
                };

                function assert(name, condition, details = '') {
                    if (condition) {
                        results.passed++;
                        results.tests.push({ name, status: 'PASS', details });
                        console.log('  [PASS]', name);
                    } else {
                        results.failed++;
                        results.tests.push({ name, status: 'FAIL', details });
                        console.error('  [FAIL]', name, details);
                    }
                }

                const view = new AssistantView();
                document.getElementById('container').appendChild(view);
                await view.updateComplete;

                // Test 1: Markdown Rendering
                console.log('\\n1. Testing Markdown rendering...');
                const mdSample = '# Header 1\\n**Bold text** and *italic text*\\n- Item 1\\n- Item 2\\n\\n\`\`\`js\\nconsole.log("hello");\\n\`\`\`';
                const renderedMd = view.renderMarkdown(mdSample);
                assert('Markdown headers rendered', renderedMd.includes('<h1>Header 1</h1>'));
                assert('Markdown bold rendered', renderedMd.includes('<strong>Bold text</strong>'));
                assert('Markdown list rendered', renderedMd.includes('<li>Item 1</li>') && renderedMd.includes('<li>Item 2</li>'));
                assert('Markdown code rendered', renderedMd.includes('<code>') || renderedMd.includes('<pre>'));
                assert('No data-word spans created', !renderedMd.includes('data-word'));

                // Test 2: DOMPurify Sanitization
                console.log('\\n2. Testing DOMPurify sanitization...');
                const maliciousSample = 'Dangerous <script>alert("xss")</script><img src="x" onerror="alert(1)">safe text';
                const sanitized = view.renderMarkdown(maliciousSample);
                assert('Script tags removed', !sanitized.includes('<script>') && !sanitized.includes('alert("xss")'));
                assert('Onerror handlers stripped', !sanitized.includes('onerror='));
                assert('Safe text preserved', sanitized.includes('safe text'));

                // Test 3: Short response immediate render
                console.log('\\n3. Testing short response immediate render...');
                view.responses = ['Hello world!'];
                view.currentResponseIndex = 0;
                await view.updateComplete;
                // Wait for any microtask / immediate render
                const container = view.shadowRoot.querySelector('#responseContainer');
                assert('Short response rendered', container.innerHTML.includes('Hello world!'));

                // Test 4: Streaming chunk simulation and RAF coalescing
                console.log('\\n4. Testing streaming chunks (72 chunks rapid-fire)...');
                let renderCallCount = 0;
                const originalRenderNow = view._renderResponseContentNow.bind(view);
                view._renderResponseContentNow = function() {
                    renderCallCount++;
                    return originalRenderNow();
                };

                const chunks = [];
                let fullString = '';
                for (let i = 1; i <= 72; i++) {
                    fullString += ' token' + i;
                    chunks.push(fullString);
                }

                // Simulate incoming stream: chunk 1 is new response, chunks 2..72 are updates
                view.responses = [chunks[0]];
                view.currentResponseIndex = 0;
                await view.updateComplete;

                // Send chunks 2..72 rapidly with ~3ms spacing (matching Groq ~270 chunks/s)
                const streamStartTime = performance.now();
                for (let i = 1; i < chunks.length; i++) {
                    view.responses = [chunks[i]];
                    view.requestUpdate();
                    // small delay simulating Groq burst (every ~3ms)
                    await new Promise(r => setTimeout(r, 3));
                }

                // Wait for final frame to settle
                await new Promise(r => setTimeout(r, 50));
                const streamDuration = performance.now() - streamStartTime;

                console.log('  Stream simulation finished in ' + streamDuration.toFixed(1) + 'ms');
                console.log('  Total chunks sent: ' + chunks.length);
                console.log('  Total DOM renders executed: ' + renderCallCount);

                assert('Chunks coalesced significantly (< 72 renders)', renderCallCount < 72, 
                    'Actual renders: ' + renderCallCount + ' vs 72 chunks');
                assert('Coalescing ratio at least 2x reduction', renderCallCount <= 36,
                    'Coalescing reduced renders from 72 to ' + renderCallCount);
                assert('Final text contains complete response', container.innerHTML.includes('token72'));

                // Test 5: Rapid consecutive responses
                console.log('\\n5. Testing rapid consecutive responses...');
                view.responses = [...view.responses, 'Task B Response starting'];
                view.currentResponseIndex = 1;
                await view.updateComplete;
                assert('Task B response rendered cleanly', container.innerHTML.includes('Task B Response starting'));
                assert('Task B does not show Task A', !container.innerHTML.includes('token72'));

                // Test 6: Navigation back and forth
                console.log('\\n6. Testing response navigation...');
                view.navigateToPreviousResponse();
                await view.updateComplete;
                assert('Navigated back to Response 1', container.innerHTML.includes('token72'));
                view.navigateToNextResponse();
                await view.updateComplete;
                assert('Navigated forward to Response 2', container.innerHTML.includes('Task B Response starting'));

                return results;
            };
        </script>
    </body>
    </html>
    `;

    const tmpHtmlPath = path.join(__dirname, 'test_renderer_tmp.html');
    fs.writeFileSync(tmpHtmlPath, htmlContent);

    try {
        await win.loadFile(tmpHtmlPath);
        // Wait for page scripts to load
        await new Promise(r => setTimeout(r, 1000));

        const testResults = await win.webContents.executeJavaScript('window.runTestSuite()');
        console.log('\n[TEST_RENDERER RESULTS]');
        console.log('Passed:', testResults.passed);
        console.log('Failed:', testResults.failed);

        fs.writeFileSync(
            path.join(__dirname, 'renderer_test_results.json'),
            JSON.stringify(testResults, null, 2)
        );

        if (testResults.failed > 0) {
            console.error('Some renderer tests failed!');
            process.exit(1);
        } else {
            console.log('All renderer tests passed successfully!');
        }
    } catch (err) {
        console.error('Error running renderer tests:', err);
        process.exit(1);
    } finally {
        if (fs.existsSync(tmpHtmlPath)) {
            fs.unlinkSync(tmpHtmlPath);
        }
        app.quit();
    }
});


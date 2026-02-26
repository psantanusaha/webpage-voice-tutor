const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body><p data-la-id="test-1">Hello World</p></body></html>');
global.document = dom.window.document;
global.window = dom.window;

dom.window.HTMLElement.prototype.scrollIntoView = function() {
    console.log('   [DOM] scrollIntoView called on element:', this.getAttribute('data-la-id'));
};

function handleAgentAction(action, payload) {
    console.log(`🚀 Executing action: ${action}`, payload);
    const element = document.querySelector(`[data-la-id="${payload.id}"]`);
    
    if (!element) {
        console.warn(`   [WARN] Element with ID ${payload.id} not found.`);
        return;
    }

    switch (action) {
        case 'scroll_to':
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
        case 'highlight':
            const originalBackground = element.style.backgroundColor;
            element.style.backgroundColor = '#fef08a';
            console.log('   [DOM] Background set to highlight color');
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
                element.style.backgroundColor = originalBackground;
                console.log('   [DOM] Background restored');
            }, 10);
            break;
    }
}

console.log("--- TEST 1: Scroll To Existing Element ---");
handleAgentAction('scroll_to', { id: 'test-1' });

console.log("\n--- TEST 2: Highlight Existing Element ---");
handleAgentAction('highlight', { id: 'test-1' });

console.log("\n--- TEST 3: Non-existent Element ---");
handleAgentAction('highlight', { id: 'missing-id' });

setTimeout(() => console.log("\n✅ Logic Tests completed."), 50);

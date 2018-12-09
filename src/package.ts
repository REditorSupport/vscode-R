import { createRTerm, rTerm } from "./rTerminal";

export async function loadAllPkg() {
    if (!rTerm) {
        const success = createRTerm(true);
        if (!success) { return; }
    }

    const rLoadAllCommand = "devtools::load_all('.')";
    rTerm.sendText(rLoadAllCommand);
}

export async function testPkg() {
    if (!rTerm) {
        const success = createRTerm(true);
        if (!success) { return; }
    }

    const rTestCommand = "devtools::test()";
    rTerm.sendText(rTestCommand);
}

export async function installPkg() {
    if (!rTerm) {
        const success = createRTerm(true);
        if (!success) { return; }
    }

    const rInstallCommand = "devtools::install()";
    rTerm.sendText(rInstallCommand);
}

export async function buildPkg() {
    if (!rTerm) {
        const success = createRTerm(true);
        if (!success) { return; }
    }

    const rBuildCommand = "devtools::build()";
    rTerm.sendText(rBuildCommand);
}

export async function documentPkg() {
    if (!rTerm) {
        const success = createRTerm(true);
        if (!success) { return; }
    }

    const rDocumentCommand = "devtools::document()";
    rTerm.sendText(rDocumentCommand);
}

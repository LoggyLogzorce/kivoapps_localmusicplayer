async function normalizeAudioFile(filePath) {
    if (!filePath.endsWith(".flac")) {
        return "skip";
    }

    // тут пока просто заглушка
    console.log("checking", filePath);

    return "ok";
}

module.exports = {
    normalizeAudioFile
};
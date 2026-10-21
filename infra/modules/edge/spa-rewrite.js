function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // Never rewrite backend requests.
    if (
        uri === '/api' ||
        uri.indexOf('/api/') === 0 ||
        uri === '/health' ||
        uri.indexOf('/health/') === 0
    ) {
        return request;
    }

    // Only rewrite browser navigation requests.
    var accept = request.headers.accept
        ? request.headers.accept.value
        : '';

    if (accept.indexOf('text/html') === -1) {
        return request;
    }

    // Leave static files unchanged.
    var lastSegment = uri.split('/').pop();

    if (lastSegment.indexOf('.') !== -1) {
        return request;
    }

    request.uri = '/index.html';
    return request;
}

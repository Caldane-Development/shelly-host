FROM nginx:alpine

# Build context is the repo root (matches server/client image builds).
COPY proxy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

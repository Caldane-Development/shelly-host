FROM node:24
# Update Debian packages to reduce vulnerabilities
RUN apt update && apt upgrade -y
RUN apt install -y curl

EXPOSE 4500

RUN mkdir -p /app/server /app/common

WORKDIR /app/server

COPY server/package*.json ./

RUN npm i

COPY server ./
COPY common /app/common

CMD ["npm", "run", "dev"]
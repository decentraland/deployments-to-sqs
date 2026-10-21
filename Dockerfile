ARG RUN

FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d as builderenv

WORKDIR /app

# some packages require a build step (node-gyp toolchain)
RUN apk add --no-cache python3 py3-setuptools make g++

# install dependencies
COPY package.json /app/package.json
COPY yarn.lock /app/yarn.lock
RUN yarn install --frozen-lockfile

# build the app
COPY . /app
RUN yarn run build
RUN yarn run test

# remove devDependencies, keep only used dependencies
RUN yarn install --frozen-lockfile --production

########################## END OF BUILD STAGE ##########################

FROM node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d

# NODE_ENV is used to configure some runtime options, like JSON logger
ENV NODE_ENV production

# We use Tini to handle signals and PID1 (https://github.com/krallin/tini, read why here https://github.com/krallin/tini/issues/8)
RUN apk add --no-cache tini

WORKDIR /app
COPY --from=builderenv /app /app
# Please _DO NOT_ use a custom ENTRYPOINT because it may prevent signals
# (i.e. SIGTERM) to reach the service
# Read more here: https://aws.amazon.com/blogs/containers/graceful-shutdowns-with-ecs/
#            and: https://www.ctl.io/developers/blog/post/gracefully-stopping-docker-containers/
ENTRYPOINT ["/sbin/tini", "--"]
# Run the program under Tini
CMD [ "/usr/local/bin/node", "--trace-warnings", "--abort-on-uncaught-exception", "--unhandled-rejections=strict", "dist/index.js" ]

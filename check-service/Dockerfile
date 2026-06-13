# build a static binary; quic-go is pure Go, so no curl/cgo needed
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /check .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
USER app
COPY --from=build /check /check
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/check"]
